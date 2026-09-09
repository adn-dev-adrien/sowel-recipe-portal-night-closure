import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRecipe,
  msUntilTime,
  inWindow,
  isValidHHMM,
  readAttempts,
  readMode,
  readDoubtPolicy,
  readAutoCloseMode,
  levellingPulses,
  portalStateOf,
  type PortalState,
} from "./index.js";

// ============================================================
// Test doubles
// ============================================================

type OrderCall = { equipmentId: string; alias: string; value: unknown };

const PORTAL = "portal-1";

/**
 * A portal whose contact only reports `closed` when `sensorSeesClosed` is true —
 * the whole point of this recipe. `physical` is the truth the sensor may miss.
 */
function buildCtx(options: {
  physical?: "open" | "closed";
  /** How many closing manoeuvres before the contact finally catches. Infinity = never. */
  detectsAfter?: number;
  travelMs?: number;
} = {}) {
  const travelMs = options.travelMs ?? 40_000;
  let physical: "open" | "closed" = options.physical ?? "closed";
  let sensor: PortalState = physical === "closed" ? "closed" : "open";
  let closingsSoFar = 0;
  let coreTimedAction: { expiresAt: string } | null = null;
  const detectsAfter = options.detectsAfter ?? Infinity;

  const orderCalls: OrderCall[] = [];
  const state = new Map<string, unknown>();
  const logLines: string[] = [];
  const handlers: Array<(event: Record<string, unknown>) => void> = [];

  function emitState(value: PortalState): void {
    for (const handler of handlers) {
      handler({ type: "equipment.data.changed", equipmentId: PORTAL, alias: "state", value });
    }
  }

  /** Simulate the motor: an impulse toggles, and the contact may miss it. */
  function toggle(): void {
    sensor = "unknown";
    emitState("unknown");
    setTimeout(() => {
      physical = physical === "closed" ? "open" : "closed";
      if (physical === "closed") {
        closingsSoFar++;
        sensor = closingsSoFar >= detectsAfter ? "closed" : "open";
      } else {
        sensor = "open";
      }
      emitState(sensor);
    }, travelMs);
  }

  const ctx = {
    eventBus: {
      onType: (type: string, handler: (event: Record<string, unknown>) => void) => {
        if (type === "equipment.data.changed") handlers.push(handler);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    },
    equipmentManager: {
      getById: (id: string) => ({ id, name: "Portail", type: "gate" }),
      getByIdWithDetails: (id: string) => ({
        id,
        name: "Portail",
        type: "gate",
        dataBindings: [{ alias: "state", category: "gate_state", value: sensor }],
        orderBindings: [{ alias: "command", category: "gate_trigger", type: "boolean" }],
        ...(coreTimedAction ? { timedAction: coreTimedAction } : {}),
      }),
    },
    zoneManager: { getById: () => null },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    state: {
      get: (k: string) => state.get(k) ?? null,
      set: (k: string, v: unknown) => {
        state.set(k, v);
      },
      delete: (k: string) => {
        state.delete(k);
      },
      clear: () => state.clear(),
    },
    log: (msg: string) => {
      logLines.push(msg);
    },
    helpers: {
      parseDuration: (value: unknown) => {
        if (typeof value === "number") return value;
        const m = String(value).match(/^(\d+)\s*(s|m|h)$/);
        if (!m) throw new Error(`Invalid duration format: ${value}`);
        const n = parseInt(m[1], 10);
        return m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
      },
      formatDuration: (ms: number) => `${Math.round(ms / 60_000)}min`,
    },
    dispatchOrder: async (equipmentId: string, alias: string, value: unknown) => {
      orderCalls.push({ equipmentId, alias, value });
      if (alias === "command") toggle();
      return { success: true };
    },
  };

  return {
    ctx,
    orderCalls,
    state,
    logLines,
    emitState,
    physicalState: () => physical,
    sensorState: () => sensor,
    setSensor: (value: PortalState) => {
      sensor = value;
      emitState(value);
    },
    /** The core's own timed action (spec 174), armed from the portal's tile. */
    setCoreTimedAction: (expiresAt: string | null) => {
      coreTimedAction = expiresAt === null ? null : { expiresAt };
    },
    /** Someone really opens the portal: the contact leaves the reed for good. */
    openPortal: () => {
      physical = "open";
      sensor = "open";
      emitState("open");
    },
  };
}

const BASE_PARAMS = {
  zone: "z1",
  portal: PORTAL,
  closingTime: "22:30",
  watchUntil: "06:00",
  reopenGrace: "10m",
  commandMode: "pulse_toggle",
  travelTime: "40s",
  attempts: 2,
  doubtPolicy: "restore",
};

/** Let every pending timer and awaited microtask of a sequence run. */
async function settle(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// ============================================================
// Pure helpers
// ============================================================

describe("isValidHHMM", () => {
  it("accepts a 24h time", () => expect(isValidHHMM("22:30")).toBe(true));
  it("rejects nonsense", () => {
    expect(isValidHHMM("24:00")).toBe(false);
    expect(isValidHHMM("7:30")).toBe(false);
    expect(isValidHHMM("")).toBe(false);
    expect(isValidHHMM(null)).toBe(false);
  });
});

describe("msUntilTime", () => {
  it("counts to a time later today", () => {
    expect(msUntilTime("22:30", new Date("2026-08-29T20:00:00"))).toBe(2.5 * 3600_000);
  });
  it("rolls over to tomorrow once the time has passed", () => {
    expect(msUntilTime("22:30", new Date("2026-08-29T22:30:00"))).toBe(24 * 3600_000);
  });
});

describe("inWindow", () => {
  it("handles a window that wraps past midnight", () => {
    expect(inWindow("22:30", "06:00", new Date("2026-08-29T23:00:00"))).toBe(true);
    expect(inWindow("22:30", "06:00", new Date("2026-08-30T02:00:00"))).toBe(true);
    expect(inWindow("22:30", "06:00", new Date("2026-08-30T05:59:00"))).toBe(true);
    expect(inWindow("22:30", "06:00", new Date("2026-08-30T06:00:00"))).toBe(false);
    expect(inWindow("22:30", "06:00", new Date("2026-08-29T21:00:00"))).toBe(false);
  });
  it("handles a same-day window", () => {
    expect(inWindow("08:00", "12:00", new Date("2026-08-29T09:00:00"))).toBe(true);
    expect(inWindow("08:00", "12:00", new Date("2026-08-29T13:00:00"))).toBe(false);
  });
  it("an empty window is never active", () => {
    expect(inWindow("22:30", "22:30", new Date("2026-08-29T22:30:00"))).toBe(false);
  });
});

describe("readAttempts", () => {
  it("clamps to 1..5", () => {
    expect(readAttempts(0)).toBe(1);
    expect(readAttempts(99)).toBe(5);
    expect(readAttempts(3)).toBe(3);
  });
  it("falls back on garbage", () => expect(readAttempts("abc")).toBe(2));
});

describe("readMode / readDoubtPolicy", () => {
  it("defaults to the ambiguous impulse and the conservative policy", () => {
    expect(readMode(undefined)).toBe("pulse_toggle");
    expect(readMode("close_command")).toBe("close_command");
    expect(readDoubtPolicy(undefined)).toBe("restore");
    expect(readDoubtPolicy("force_close")).toBe("force_close");
  });
});

describe("readAutoCloseMode", () => {
  it("is off unless something explicitly says on", () => {
    expect(readAutoCloseMode(undefined)).toBe("off");
    expect(readAutoCloseMode(null)).toBe("off");
    expect(readAutoCloseMode("nonsense")).toBe("off");
    expect(readAutoCloseMode("on")).toBe("on");
  });
});

describe("levellingPulses", () => {
  it("returns the portal to its initial state on an even parity", () => {
    expect(levellingPulses(1, "even")).toBe(1);
    expect(levellingPulses(2, "even")).toBe(0);
  });
  it("ends on a closing manoeuvre on an odd parity", () => {
    expect(levellingPulses(2, "odd")).toBe(1);
    expect(levellingPulses(1, "odd")).toBe(0);
  });
});

describe("portalStateOf", () => {
  it("reads the virtual gate_state binding", () => {
    expect(
      portalStateOf({
        name: "g",
        dataBindings: [{ alias: "state", category: "gate_state", value: "closed" }],
        orderBindings: [],
      }),
    ).toBe("closed");
  });
  it("anything else is unknown", () => {
    expect(portalStateOf(null)).toBe("unknown");
    expect(portalStateOf({ name: "g", dataBindings: [], orderBindings: [] })).toBe("unknown");
  });
});

// ============================================================
// validate()
// ============================================================

describe("validate", () => {
  const recipe = createRecipe();

  it("accepts a sane configuration", () => {
    const { ctx } = buildCtx();
    expect(() => recipe.validate(BASE_PARAMS, ctx as never)).not.toThrow();
  });

  it("refuses an equipment that is not a portal", () => {
    const { ctx } = buildCtx();
    const notAPortal = {
      ...ctx,
      equipmentManager: {
        ...ctx.equipmentManager,
        getById: (id: string) => ({ id, name: "Lampe", type: "light_onoff" }),
      },
    };
    expect(() => recipe.validate(BASE_PARAMS, notAPortal as never)).toThrow(/not a portal/);
  });

  it("refuses an invalid closing time", () => {
    const { ctx } = buildCtx();
    expect(() => recipe.validate({ ...BASE_PARAMS, closingTime: "25:00" }, ctx as never)).toThrow(
      /HH:MM/,
    );
  });

  it("refuses a watch window that ends when it starts", () => {
    const { ctx } = buildCtx();
    expect(() => recipe.validate({ ...BASE_PARAMS, watchUntil: "22:30" }, ctx as never)).toThrow(
      /differ/,
    );
  });

  it("refuses an unparseable travel time", () => {
    const { ctx } = buildCtx();
    expect(() => recipe.validate({ ...BASE_PARAMS, travelTime: "bientôt" }, ctx as never)).toThrow(
      /Travel time/,
    );
  });

  it("refuses a close command the portal does not have", () => {
    const { ctx } = buildCtx();
    expect(() =>
      recipe.validate(
        { ...BASE_PARAMS, commandMode: "close_command", closeCommandAlias: "R2" },
        ctx as never,
      ),
    ).toThrow(/No "R2" command/);
  });

  it("refuses a close value outside the binding's enum", () => {
    const { ctx } = buildCtx();
    const withEnum = {
      ...ctx,
      equipmentManager: {
        ...ctx.equipmentManager,
        getByIdWithDetails: (id: string) => ({
          id,
          name: "Portail",
          type: "gate",
          dataBindings: [],
          orderBindings: [
            { alias: "command", type: "enum", enumValues: ["OPEN", "CLOSE", "PEDESTRIAN"] },
          ],
        }),
      },
    };
    expect(() =>
      recipe.validate(
        { ...BASE_PARAMS, commandMode: "close_command", closeCommandValue: "FERMER" },
        withEnum as never,
      ),
    ).toThrow(/not one of this command's values/);
    expect(() =>
      recipe.validate(
        { ...BASE_PARAMS, commandMode: "close_command", closeCommandValue: "close" },
        withEnum as never,
      ),
    ).not.toThrow();
  });
});

// ============================================================
// The nightly closure
// ============================================================

describe("nightly closure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when the contact already reports closed", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    await settle(2.5 * 3600_000 + 1000);

    expect(h.orderCalls).toHaveLength(0);
    expect(h.state.get("belief")).toBe("closed");
    expect(h.state.get("confirmed")).toBe(true);
    expect(h.state.get("alarm")).toBe(false);
    instance.stop();
  });

  it("closes a portal whose opening was observed, and confirms it", async () => {
    // The contact starts closed, someone opens the portal at 20:10: that edge is
    // the evidence the recipe needs to pulse without gambling.
    const h = buildCtx({ physical: "closed", detectsAfter: 1 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    await settle(10 * 60_000);
    h.openPortal();
    expect(h.state.get("belief")).toBe("open");

    await settle(2.5 * 3600_000);
    await settle(60_000);

    expect(h.orderCalls).toHaveLength(1);
    expect(h.state.get("belief")).toBe("closed");
    expect(h.state.get("confirmed")).toBe(true);
    expect(h.state.get("alarm")).toBe(false);
    instance.stop();
  });

  it("stops the sequence the moment the contact confirms, mid-attempts", async () => {
    const h = buildCtx({ physical: "open", detectsAfter: 1 });
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, attempts: 5 },
      h.ctx as never,
    );

    await settle(2.5 * 3600_000 + 5 * 60_000);

    expect(h.orderCalls).toHaveLength(1);
    expect(h.physicalState()).toBe("closed");
    expect(h.state.get("confirmed")).toBe(true);
    instance.stop();
  });

  it("in doubt, gives the contact a second chance and puts the portal back (restore)", async () => {
    // The portal is really closed; the contact never sees it. Two impulses = one
    // full open/close cycle, and the portal ends where it started.
    const h = buildCtx({ physical: "closed", detectsAfter: Infinity });
    h.setSensor("open"); // contact stuck open, no edge observed
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    expect(h.state.get("belief")).toBe("doubt");

    await settle(2.5 * 3600_000 + 10 * 60_000);

    expect(h.orderCalls).toHaveLength(2);
    expect(h.physicalState()).toBe("closed"); // back where it was
    expect(h.state.get("alarm")).toBe(true);
    expect(h.state.get("belief")).toBe("doubt");
    instance.stop();
  });

  it("restore adds a levelling impulse when the attempt count is odd", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: Infinity });
    h.setSensor("open");
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, attempts: 3 },
      h.ctx as never,
    );

    await settle(2.5 * 3600_000 + 15 * 60_000);

    expect(h.orderCalls).toHaveLength(4); // 3 attempts + 1 levelling
    expect(h.physicalState()).toBe("closed");
    expect(h.state.get("alarm")).toBe(true);
    instance.stop();
  });

  it("force_close ends on a closing manoeuvre", async () => {
    // Here the contact is right: the portal really is open.
    const h = buildCtx({ physical: "open", detectsAfter: Infinity });
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, doubtPolicy: "force_close" },
      h.ctx as never,
    );

    await settle(2.5 * 3600_000 + 10 * 60_000);

    expect(h.orderCalls).toHaveLength(3); // 2 attempts + 1 to land on odd
    expect(h.physicalState()).toBe("closed");
    expect(h.state.get("alarm")).toBe(true); // closed, but nothing proves it
    instance.stop();
  });

  it("alert_only never moves the portal in doubt", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: Infinity });
    h.setSensor("open");
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, doubtPolicy: "alert_only" },
      h.ctx as never,
    );

    await settle(2.5 * 3600_000 + 10 * 60_000);

    expect(h.orderCalls).toHaveLength(0);
    expect(h.state.get("alarm")).toBe(true);
    expect(h.logLines.some((l) => l.includes("alerter seulement"))).toBe(true);
    instance.stop();
  });

  it("a dedicated close command is sent whatever the contact says, without alarm", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: Infinity });
    h.setSensor("open");
    const instance = createRecipe().createInstance(
      {
        ...BASE_PARAMS,
        commandMode: "close_command",
        closeCommandAlias: "command",
        closeCommandValue: "CLOSE",
        attempts: 2,
      },
      h.ctx as never,
    );

    await settle(2.5 * 3600_000 + 10 * 60_000);

    expect(h.orderCalls.map((c) => c.value)).toEqual(["CLOSE", "CLOSE"]);
    // The command means "close": the portal is deemed closed, only the sensor is faulty.
    expect(h.state.get("belief")).toBe("closed");
    expect(h.state.get("confirmed")).toBe(false);
    expect(h.state.get("alarm")).toBe(false);
    instance.stop();
  });

  it("a late contact clears the alarm on its own", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: Infinity });
    h.setSensor("open");
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    await settle(2.5 * 3600_000 + 10 * 60_000);
    expect(h.state.get("alarm")).toBe(true);

    h.setSensor("closed"); // the portal settles, the reed finally catches
    expect(h.state.get("alarm")).toBe(false);
    expect(h.state.get("belief")).toBe("closed");
    expect(h.state.get("confirmed")).toBe(true);
    instance.stop();
  });

  it("raises the alarm and touches nothing when no command can be dispatched", async () => {
    const h = buildCtx({ physical: "open", detectsAfter: Infinity });
    const failing = {
      ...h.ctx,
      dispatchOrder: async () => ({ success: false, error: "integration disconnected" }),
    };
    const instance = createRecipe().createInstance(BASE_PARAMS, failing as never);

    await settle(2.5 * 3600_000 + 10 * 60_000);

    expect(h.state.get("alarm")).toBe(true);
    expect(h.state.get("belief")).toBe("doubt");
    instance.stop();
  });

  it("stops the sequence and says so when a command stops going through", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: Infinity });
    h.setSensor("open");
    let calls = 0;
    const flaky = {
      ...h.ctx,
      dispatchOrder: async (equipmentId: string, alias: string, value: unknown) => {
        calls++;
        if (calls === 1) return h.ctx.dispatchOrder(equipmentId, alias, value);
        return { success: false, error: "integration disconnected" };
      },
    };
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, attempts: 3 },
      flaky as never,
    );

    await settle(2.5 * 3600_000 + 10 * 60_000);

    // One impulse went out, the second was refused: the sequence stops
    // attempting rather than waiting out travels that never happen, tries once
    // to put the portal back, and — that levelling impulse being refused too —
    // says the portal is somewhere in between instead of claiming it was restored.
    expect(calls).toBe(3);
    expect(h.state.get("alarm")).toBe(true);
    expect(h.logLines.some((l) => l.includes("état indéterminé"))).toBe(true);
    instance.stop();
  });

  it("re-arms for the next evening", async () => {
    const h = buildCtx({ physical: "open", detectsAfter: 1 });
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, watchUntil: "" },
      h.ctx as never,
    );

    await settle(2.5 * 3600_000 + 5 * 60_000);
    expect(h.orderCalls).toHaveLength(1);

    // Someone opens it again the next day, and the recipe closes it again.
    h.setSensor("open");
    await settle(24 * 3600_000);
    expect(h.orderCalls.length).toBeGreaterThan(1);
    instance.stop();
  });
});

// ============================================================
// The night watch
// ============================================================

describe("night watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the portal again when it is genuinely opened during the night", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    await settle(2.5 * 3600_000 + 60_000); // past the closing time, nothing to do
    expect(h.orderCalls).toHaveLength(0);
    expect(h.state.get("status")).toBe("watching");

    h.openPortal(); // 23:31 — someone comes home
    await settle(9 * 60_000);
    expect(h.orderCalls).toHaveLength(0); // still inside the grace

    await settle(2 * 60_000);
    expect(h.orderCalls).toHaveLength(1); // grace elapsed → closed again
    instance.stop();
  });

  it("cancels the re-closing when the portal closes on its own during the grace", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    await settle(2.5 * 3600_000 + 60_000);
    h.openPortal();
    await settle(60_000);
    h.setSensor("closed");
    await settle(20 * 60_000);

    expect(h.orderCalls).toHaveLength(0);
    instance.stop();
  });

  it("ignores an opening outside the watch window", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    h.openPortal(); // 20:00, long before the closing time
    await settle(20 * 60_000);

    expect(h.orderCalls).toHaveLength(0);
    instance.stop();
  });

  it("an unconfirmed closure does not survive the night", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: Infinity });
    const instance = createRecipe().createInstance(
      {
        ...BASE_PARAMS,
        commandMode: "close_command",
        closeCommandValue: "CLOSE",
        attempts: 1,
      },
      h.ctx as never,
    );
    h.setSensor("open");

    await settle(2.5 * 3600_000 + 5 * 60_000);
    expect(h.state.get("belief")).toBe("closed");
    expect(h.state.get("confirmed")).toBe(false);

    await settle(8 * 3600_000); // past 06:00
    expect(h.state.get("belief")).toBe("doubt");
    expect(h.state.get("status")).toBe("idle");
    instance.stop();
  });
});


// ============================================================
// The armed auto-closing mode
// ============================================================

describe("auto-closing mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:00:00")); // broad daylight, no night watch
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function arm(instance: { onAction?: (a: string, p?: Record<string, unknown>) => void }): void {
    instance.onAction?.("set_auto_close", { mode: "on" });
  }
  function disarm(instance: { onAction?: (a: string, p?: Record<string, unknown>) => void }): void {
    instance.onAction?.("set_auto_close", { mode: "off" });
  }

  it("declares the toggle and the tile the Dashboard needs", () => {
    const recipe = createRecipe();
    expect(recipe.actions?.[0]).toMatchObject({
      id: "set_auto_close",
      type: "cycle",
      stateKey: "autoClose",
    });
    expect(recipe.actions?.[0].options.map((o) => o.value)).toEqual(["off", "on"]);
    expect(recipe.tile?.actions).toEqual(["set_auto_close"]);
    // Arming moves nothing, so it is not guarded — see the tile declaration.
    expect(recipe.tile?.confirm).toBeUndefined();
    expect(recipe.tile?.confirmFrom).toBeUndefined();
  });

  it("publishes the resting mode at once, or the pill would never show", () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    expect(h.state.get("autoClose")).toBe("off");
    expect(typeof h.state.get("summary")).toBe("string");
    instance.stop();
  });

  it("closes the portal after the grace, in broad daylight, once armed", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    h.openPortal();
    await settle(20 * 60_000);
    expect(h.orderCalls).toHaveLength(0); // mode off: an opening is nobody's business
    h.setSensor("closed");

    arm(instance);
    expect(h.state.get("autoClose")).toBe("on");

    h.openPortal();
    await settle(9 * 60_000);
    expect(h.orderCalls).toHaveLength(0); // still inside the grace

    await settle(2 * 60_000);
    expect(h.orderCalls).toHaveLength(1);
    instance.stop();
  });

  it("stays armed: the opening after the one it closed is closed too", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    h.openPortal();
    await settle(11 * 60_000);
    expect(h.orderCalls).toHaveLength(1);
    expect(h.state.get("autoClose")).toBe("on");

    h.openPortal();
    await settle(11 * 60_000);
    expect(h.orderCalls).toHaveLength(2);
    instance.stop();
  });

  it("feeds the countdown while a closure is pending, and clears it after", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    h.openPortal();
    await settle(60_000);
    const deadline = h.state.get("timerExpiresAt");
    expect(typeof deadline).toBe("string");
    expect(new Date(String(deadline)).getTime()).toBe(
      new Date("2026-08-29T20:00:00").getTime() + 10 * 60_000,
    );

    await settle(11 * 60_000);
    expect(h.state.get("timerExpiresAt")).toBeNull();
    instance.stop();
  });

  it("arms the countdown when switched on over a portal it saw open", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    h.openPortal(); // observed edge, mode still off
    await settle(20 * 60_000);
    expect(h.orderCalls).toHaveLength(0);

    arm(instance);
    expect(h.state.get("timerExpiresAt")).not.toBeNull();
    await settle(11 * 60_000);
    expect(h.orderCalls).toHaveLength(1);
    instance.stop();
  });

  it("never gambles: switched on over a bare 'open' contact, it waits", async () => {
    const h = buildCtx({ physical: "open", detectsAfter: Infinity });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    expect(h.state.get("belief")).toBe("doubt"); // no edge was ever observed

    arm(instance);
    expect(h.state.get("timerExpiresAt")).toBeNull();
    await settle(30 * 60_000);
    expect(h.orderCalls).toHaveLength(0); // an impulse here could OPEN a closed portal
    instance.stop();
  });

  it("switching the mode off drops the closure it was holding", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    h.openPortal();
    await settle(5 * 60_000);
    expect(h.state.get("timerExpiresAt")).not.toBeNull();

    disarm(instance);
    expect(h.state.get("timerExpiresAt")).toBeNull();
    await settle(30 * 60_000);
    expect(h.orderCalls).toHaveLength(0);
    instance.stop();
  });

  it("arms and disarms itself on the scheduled hours", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, closingTime: "03:00", autoCloseFrom: "21:00", autoCloseUntil: "23:00" },
      h.ctx as never,
    );
    expect(h.state.get("autoClose")).toBe("off");

    await settle(61 * 60_000); // 21:01
    expect(h.state.get("autoClose")).toBe("on");

    await settle(120 * 60_000); // 23:01
    expect(h.state.get("autoClose")).toBe("off");
    instance.stop();
  });

  it("a restart inside the scheduled window comes back armed", () => {
    vi.setSystemTime(new Date("2026-08-29T22:00:00"));
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, closingTime: "03:00", autoCloseFrom: "21:00", autoCloseUntil: "23:00" },
      h.ctx as never,
    );
    expect(h.state.get("autoClose")).toBe("on");
    instance.stop();
  });

  it("keeps the mode across a restart, but never a stale countdown", () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    h.state.set("autoClose", "on");
    h.state.set("timerExpiresAt", "2026-08-29T19:00:00.000Z"); // a deadline that died
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    expect(h.state.get("autoClose")).toBe("on");
    expect(h.state.get("timerExpiresAt")).toBeNull();
    instance.stop();
  });

  it("a restart over an open portal waits for a real opening rather than pulsing", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    h.state.set("autoClose", "on");
    h.state.set("belief", "open");
    h.setSensor("open");
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    await settle(30 * 60_000);
    expect(h.orderCalls).toHaveLength(0);
    instance.stop();
  });

  it("mode and night watch together send one impulse, not two", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    await settle(2.5 * 3600_000 + 60_000); // past 22:30, both reasons to watch now hold
    expect(h.orderCalls).toHaveLength(0); // the portal is closed and confirmed

    h.openPortal();
    await settle(30 * 60_000);
    expect(h.orderCalls).toHaveLength(1);
    instance.stop();
  });

  it("switching the mode off at night leaves the night watch its closure", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);
    await settle(2.5 * 3600_000 + 60_000); // 23:31

    h.openPortal();
    await settle(60_000);
    disarm(instance);
    expect(h.state.get("timerExpiresAt")).not.toBeNull(); // the night still wants it closed

    await settle(20 * 60_000);
    expect(h.orderCalls).toHaveLength(1);
    instance.stop();
  });

  it("the morning ends the night watch without disarming the mode", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    await settle(10 * 3600_000 + 5 * 60_000); // past 06:00
    expect(h.state.get("autoClose")).toBe("on");
    expect(h.state.get("status")).toBe("watching");
    instance.stop();
  });

  it("gives way to the portal's own timer instead of sending a second impulse", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    // "Open for 15 min" pressed on the portal's tile: the core owns a deadline.
    h.setCoreTimedAction("2026-08-29T20:15:00.000Z");
    h.openPortal();
    await settle(40 * 60_000);

    expect(h.state.get("timerExpiresAt")).toBeNull();
    expect(h.orderCalls).toHaveLength(0); // the core's deadline closes it, not us
    instance.stop();
  });

  it("gives way even when the portal's timer is armed after ours", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    h.openPortal();
    await settle(60_000);
    expect(h.state.get("timerExpiresAt")).not.toBeNull(); // ours is armed

    h.setCoreTimedAction("2026-08-29T20:15:00.000Z"); // then the tile is pressed
    await settle(30 * 60_000);
    expect(h.orderCalls).toHaveLength(0);
    instance.stop();
  });

  it("closes normally once the portal's timer is gone", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    arm(instance);

    h.setCoreTimedAction("2026-08-29T20:15:00.000Z");
    h.openPortal();
    await settle(60_000);
    expect(h.orderCalls).toHaveLength(0);

    h.setCoreTimedAction(null); // the core reverted, or was cancelled
    h.setSensor("closed");
    h.openPortal();
    await settle(11 * 60_000);
    expect(h.orderCalls).toHaveLength(1);
    instance.stop();
  });

  it("stop() clears the schedule timers", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, closingTime: "03:00", autoCloseFrom: "21:00", autoCloseUntil: "23:00" },
      h.ctx as never,
    );
    instance.stop();

    await settle(6 * 3600_000);
    expect(h.state.get("autoClose")).toBe("off");
    expect(h.orderCalls).toHaveLength(0);
  });
});

// ============================================================
// stop()
// ============================================================

describe("stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T20:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels every timer and leaves the portal alone", async () => {
    const h = buildCtx({ physical: "open", detectsAfter: 1 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);

    instance.stop();
    await settle(48 * 3600_000);

    expect(h.orderCalls).toHaveLength(0);
    expect(h.state.get("status")).toBe("idle");
  });

  it("is idempotent and aborts a running sequence", async () => {
    const h = buildCtx({ physical: "open", detectsAfter: Infinity });
    const instance = createRecipe().createInstance(
      { ...BASE_PARAMS, attempts: 5 },
      h.ctx as never,
    );

    await settle(2.5 * 3600_000 + 1000); // first impulse sent, travelling
    expect(h.orderCalls).toHaveLength(1);

    instance.stop();
    instance.stop();
    await settle(2 * 3600_000);

    expect(h.orderCalls).toHaveLength(1); // no further manoeuvre
  });

  it("stops listening to the portal", async () => {
    const h = buildCtx({ physical: "closed", detectsAfter: 0 });
    const instance = createRecipe().createInstance(BASE_PARAMS, h.ctx as never);
    await settle(2.5 * 3600_000 + 60_000);
    instance.stop();

    h.setSensor("open");
    await settle(30 * 60_000);

    expect(h.orderCalls).toHaveLength(0);
  });
});
