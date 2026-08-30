// ============================================================
// Portal Night Closure — external Sowel recipe
//
// One job: at a chosen hour, every evening, make sure the portal is closed.
//
// The installation this is written for has a single closed-contact sensor,
// and that sensor lies in ONE direction: the portal often stops a couple of
// centimetres short of the reed, so it reports "open" on a portal that is
// physically shut. The reverse never happens — the magnet cannot sit on the
// reed unless the portal is against its stop.
//
// That asymmetry is the whole design:
//
//     "closed" is a CERTAINTY.        "open" is only a SUSPICION.
//
// So the recipe never treats a bare "open" reading as a reason to move the
// portal. It works from three sources instead:
//
//   1. the sensor LEVEL      — trusted only when it reads closed;
//   2. the sensor TRANSITIONS — a closed → open edge is a real opening, and
//      the recipe watches for it all evening. That edge is the one moment the
//      hardware tells the truth about an opening, and it is what lets the
//      recipe act with confidence rather than gamble;
//   3. what the recipe ITSELF commanded — a closing manoeuvre it ordered and
//      timed is evidence the sensor cannot provide.
//
// From those it keeps a belief: `closed` (certain), `open` (a real opening was
// observed), or `doubt` (the contact has read open for a while, with nothing
// to say whether the portal is open or simply short of the reed).
//
// What it does at the closing hour then depends on what the portal's command
// actually means — which the user declares, because it cannot be discovered:
//
//   • `close_command`  — the controller has a close-only command (a dedicated
//     enum value, a second relay wired to its "fermeture" input, a Somfy
//     down). Closing an already-closed portal is a no-op, so the recipe simply
//     sends it and the lying sensor stops mattering at all. THIS is the
//     configuration to aim for; the README explains how to get there.
//
//   • `pulse_autoclose` — an impulse controller that re-closes on its own.
//     Both hypotheses converge on closed, so an impulse is safe too.
//
//   • `pulse_toggle`   — the ambiguous one: a single impulse that toggles.
//     On a portal that is open it closes; on a portal that is closed (sensor
//     lying) it OPENS. Nothing observable separates the two cases, so the
//     recipe:
//       – acts confidently when it saw the opening (belief `open`);
//       – in doubt, runs a bounded "recalage": impulse, wait a full travel,
//         look. It stops the instant the contact reads closed — a certainty,
//         and the goal. Each retry is a fresh closing travel, i.e. a fresh
//         chance for a portal that only "sometimes" stops short to seat itself;
//       – if nothing is ever confirmed, it does not gamble silently. It ends
//         the sequence on the parity the user chose (`restore` puts the portal
//         back where it started — the default, because a portal that reads open
//         at 22:30 is usually a closed portal with a blind sensor), raises the
//         alarm state, and keeps watching: a late contact clears it by itself.
//
// After the closing hour the recipe keeps an eye out until `watchUntil`: a
// real opening (a closed → open edge) re-arms a closure after a grace delay,
// so coming home at midnight does not leave the portal open till morning.
//
// Orders are sent on decisions only — a manual command in between is never
// overridden until the next decision.
// ============================================================

// ============================================================
// Types (mirrored from Sowel core — recipe packages don't import core)
// ============================================================

interface DataBindingLite {
  alias: string;
  category?: string;
  value?: unknown;
}

interface OrderBindingLite {
  alias: string;
  category?: string;
  type?: string;
  enumValues?: unknown[];
}

interface EquipmentLite {
  id?: string;
  name: string;
  type?: string;
  dataBindings: DataBindingLite[];
  orderBindings: OrderBindingLite[];
}

interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getById(id: string): { id: string; name: string; type?: string } | null;
    getByIdWithDetails(id: string): EquipmentLite | null;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
  dispatchOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success: boolean; error?: string }>;
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type:
    | "zone"
    | "equipment"
    | "number"
    | "duration"
    | "time"
    | "boolean"
    | "text"
    | "data-key"
    | "select";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  hiddenWhen?: { slot: string; equals: string | string[] };
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
    crossZone?: boolean;
    includeDescendants?: boolean;
  };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
  options?: Record<string, string>;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, RecipeSlotI18n>;
  groups?: Record<string, string>;
}

interface RecipeInstanceHandle {
  stop(): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
}

// ============================================================
// Domain model
// ============================================================

/** What the contact says. `unknown` is Sowel's pending-command state. */
export type PortalState = "open" | "closed" | "unknown";

/**
 * What the recipe believes, which is not what the contact says:
 *  - `closed` — the contact confirmed it (certainty);
 *  - `open`   — a closed → open edge was observed (certainty of an opening);
 *  - `doubt`  — the contact reads open with nothing to back it: the portal may
 *               be open, or closed and short of the reed.
 */
export type Belief = "closed" | "open" | "doubt";

export type CommandMode = "pulse_toggle" | "pulse_autoclose" | "close_command";

/** What to do when a `pulse_toggle` sequence ends without any confirmation. */
export type DoubtPolicy = "restore" | "force_close" | "alert_only";

/** Margin added to the travel time before reading the contact back. */
const CONFIRM_MARGIN_MS = 10_000;

const MODE_OPTIONS = [
  { value: "pulse_toggle", label: "Impulse (sequential toggle)" },
  { value: "pulse_autoclose", label: "Impulse + automatic re-closing" },
  { value: "close_command", label: "Dedicated close command" },
];

const DOUBT_OPTIONS = [
  { value: "restore", label: "Put the portal back where it was, and alert" },
  { value: "force_close", label: "End on a closing manoeuvre, and alert" },
  { value: "alert_only", label: "Never move the portal in doubt, only alert" },
];

// ============================================================
// Pure helpers (exported for tests)
// ============================================================

export function isValidHHMM(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Milliseconds from `now` to the next occurrence of an "HH:MM" local time. */
export function msUntilTime(time: string, now: Date = new Date()): number {
  const [h, m] = time.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/**
 * True when `now` falls in the [start, end) window, which normally wraps past
 * midnight (22:30 → 06:00). A window whose end equals its start is empty.
 */
export function inWindow(start: string, end: string, now: Date = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** Clamp the attempt count to something a portal motor can live with. */
export function readAttempts(value: unknown, fallback = 2): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

export function readMode(value: unknown): CommandMode {
  return value === "pulse_autoclose" || value === "close_command" ? value : "pulse_toggle";
}

export function readDoubtPolicy(value: unknown): DoubtPolicy {
  return value === "force_close" || value === "alert_only" ? value : "restore";
}

/** An impulse command toggles: only these two modes are ambiguous-free. */
export function isSafeCommandMode(mode: CommandMode): boolean {
  return mode !== "pulse_toggle";
}

/**
 * Extra impulses needed so that the sequence ends on the wanted parity.
 * `odd` leaves a toggling portal in the opposite state from where it started
 * (a closing manoeuvre when it really was open); `even` puts it back.
 */
export function levellingPulses(sent: number, wanted: "odd" | "even"): number {
  const isOdd = sent % 2 === 1;
  if (wanted === "odd") return isOdd ? 0 : 1;
  return isOdd ? 1 : 0;
}

/** Read the portal state out of an equipment's bindings (virtual `gate_state`). */
export function portalStateOf(equipment: EquipmentLite | null): PortalState {
  if (!equipment) return "unknown";
  const binding = equipment.dataBindings.find(
    (b) => b.category === "gate_state" || b.alias === "state",
  );
  const value = binding?.value;
  return value === "closed" || value === "open" ? value : "unknown";
}

// ============================================================
// Slots
// ============================================================

function buildSlots(): RecipeSlotDef[] {
  return [
    {
      id: "zone",
      name: "Zone",
      description: "Zone the recipe reports into",
      type: "zone",
      required: true,
    },
    {
      id: "portal",
      name: "Portal",
      description: "The portal to close for the night",
      type: "equipment",
      required: true,
      constraints: { equipmentType: "gate", crossZone: true },
    },
    {
      id: "closingTime",
      name: "Closing time",
      description: "The portal must be closed at this time, every evening",
      type: "time",
      required: true,
      defaultValue: "22:30",
      group: "schedule",
    },
    {
      id: "watchUntil",
      name: "Watch until",
      description:
        "Keep watching after the closing time: a portal genuinely opened during the night is closed again. Leave empty to only act at the closing time.",
      type: "time",
      required: false,
      defaultValue: "06:00",
      group: "schedule",
    },
    {
      id: "reopenGrace",
      name: "Grace after a re-opening",
      description:
        "Delay left to whoever just opened the portal during the night before it is closed again",
      type: "duration",
      required: false,
      defaultValue: "10m",
      group: "schedule",
    },
    {
      id: "commandMode",
      name: "What the portal command does",
      description:
        "An impulse that toggles cannot be sent blindly: on a closed portal it opens it. Declare what your controller does.",
      type: "select",
      required: true,
      defaultValue: "pulse_toggle",
      options: MODE_OPTIONS,
      group: "command",
    },
    {
      id: "closeCommandAlias",
      name: "Close command",
      description:
        "Order alias of the close-only command (e.g. command, R2 for a second relay wired to the controller's close input)",
      type: "text",
      required: false,
      defaultValue: "command",
      hiddenWhen: { slot: "commandMode", equals: ["pulse_toggle", "pulse_autoclose"] },
      group: "command",
    },
    {
      id: "closeCommandValue",
      name: "Close value",
      description: "Value sent on that command (e.g. CLOSE, DOWN). Empty = the binding's default.",
      type: "text",
      required: false,
      defaultValue: "",
      hiddenWhen: { slot: "commandMode", equals: ["pulse_toggle", "pulse_autoclose"] },
      group: "command",
    },
    {
      id: "travelTime",
      name: "Travel time",
      description: "Time the portal takes for a full manoeuvre, before the contact is read back",
      type: "duration",
      required: true,
      defaultValue: "40s",
      group: "command",
    },
    {
      id: "autoCloseDelay",
      name: "Automatic re-closing delay",
      description: "Delay the controller waits, once open, before closing on its own",
      type: "duration",
      required: false,
      defaultValue: "2m",
      hiddenWhen: { slot: "commandMode", equals: ["pulse_toggle", "close_command"] },
      group: "command",
    },
    {
      id: "attempts",
      name: "Attempts",
      description: "Closing manoeuvres tried before giving up and alerting",
      type: "number",
      required: false,
      defaultValue: 2,
      constraints: { min: 1, max: 5 },
      group: "doubt",
    },
    {
      id: "doubtPolicy",
      name: "When nothing is confirmed",
      description:
        "With an impulse that toggles, an unconfirmed sequence leaves the portal's state unknown. Choose how it ends.",
      type: "select",
      required: false,
      defaultValue: "restore",
      options: DOUBT_OPTIONS,
      hiddenWhen: { slot: "commandMode", equals: ["pulse_autoclose", "close_command"] },
      group: "doubt",
    },
  ];
}

// ============================================================
// i18n
// ============================================================

const FR: RecipeLangPack = {
  name: "Fermeture automatique de portail en soirée",
  description:
    "S'assure que le portail est fermé pour la nuit, à l'heure choisie — sur une installation dont le seul capteur est un contact de fermeture qui rate parfois la détection.",
  slots: {
    zone: { name: "Zone", description: "Zone dans laquelle la recette rend compte" },
    portal: { name: "Portail", description: "Le portail à fermer pour la nuit" },
    closingTime: {
      name: "Heure de fermeture",
      description: "Le portail doit être fermé à cette heure, tous les soirs",
    },
    watchUntil: {
      name: "Surveiller jusqu'à",
      description:
        "Continue la surveillance après l'heure de fermeture : un portail réellement ouvert pendant la nuit est refermé. Vide = n'agir qu'à l'heure de fermeture.",
    },
    reopenGrace: {
      name: "Délai après une réouverture",
      description:
        "Temps laissé à celui qui vient d'ouvrir le portail pendant la nuit avant de le refermer",
    },
    commandMode: {
      name: "Ce que fait la commande du portail",
      description:
        "Une impulsion qui bascule ne peut pas être envoyée à l'aveugle : sur un portail fermé, elle l'ouvre. Déclarez ce que fait votre motorisation.",
      options: {
        pulse_toggle: "Impulsion (séquentielle, elle bascule)",
        pulse_autoclose: "Impulsion + refermeture automatique",
        close_command: "Commande de fermeture dédiée",
      },
    },
    closeCommandAlias: {
      name: "Commande de fermeture",
      description:
        "Alias de la commande « fermer » (ex. command, ou R2 pour un second relais câblé sur l'entrée fermeture de la motorisation)",
    },
    closeCommandValue: {
      name: "Valeur de fermeture",
      description: "Valeur envoyée sur cette commande (ex. CLOSE, DOWN). Vide = valeur par défaut.",
    },
    travelTime: {
      name: "Temps de manœuvre",
      description: "Durée d'une manœuvre complète du portail, avant de relire le capteur",
    },
    autoCloseDelay: {
      name: "Délai de refermeture automatique",
      description: "Temps que la motorisation attend, portail ouvert, avant de refermer seule",
    },
    attempts: {
      name: "Tentatives",
      description: "Nombre de manœuvres de fermeture avant d'abandonner et d'alerter",
    },
    doubtPolicy: {
      name: "Si rien n'est confirmé",
      description:
        "Avec une impulsion qui bascule, une séquence non confirmée laisse l'état du portail inconnu. Choisissez comment elle se termine.",
      options: {
        restore: "Remettre le portail dans son état initial, et alerter",
        force_close: "Terminer par une manœuvre de fermeture, et alerter",
        alert_only: "Ne jamais bouger le portail en cas de doute, alerter seulement",
      },
    },
  },
  groups: { schedule: "Horaires", command: "Commande du portail", doubt: "En cas de doute" },
};

// ============================================================
// Recipe
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "portal-night-closure",
    name: "Automatic Evening Portal Closure",
    description:
      "Makes sure the portal is closed for the night, at a chosen hour — on an installation whose only sensor is a closed-contact that sometimes misses the closure.",
    slots: buildSlots(),
    i18n: { fr: FR },

    validate(params, ctx) {
      if (!params.zone) throw new Error("Zone is required");

      const portalId = typeof params.portal === "string" ? params.portal : "";
      if (!portalId) throw new Error("A portal is required");

      const portal = ctx.equipmentManager.getById(portalId);
      if (!portal) throw new Error("Portal not found");
      if (portal.type !== undefined && portal.type !== "gate") {
        throw new Error(`Selected equipment is not a portal (type: ${portal.type})`);
      }

      if (!isValidHHMM(params.closingTime)) {
        throw new Error("Closing time must be a valid HH:MM time");
      }
      if (params.watchUntil !== undefined && params.watchUntil !== "" && params.watchUntil !== null) {
        if (!isValidHHMM(params.watchUntil)) {
          throw new Error("Watch until must be a valid HH:MM time, or empty");
        }
        if (params.watchUntil === params.closingTime) {
          throw new Error("Watch until must differ from the closing time");
        }
      }

      const mode = readMode(params.commandMode);

      try {
        const travel = ctx.helpers.parseDuration(params.travelTime ?? "40s");
        if (travel <= 0) throw new Error("Travel time must be greater than zero");
      } catch (err: unknown) {
        throw new Error(`Travel time: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (mode === "pulse_autoclose") {
        try {
          ctx.helpers.parseDuration(params.autoCloseDelay ?? "2m");
        } catch (err: unknown) {
          throw new Error(
            `Automatic re-closing delay: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (params.reopenGrace !== undefined && params.reopenGrace !== "") {
        try {
          ctx.helpers.parseDuration(params.reopenGrace);
        } catch (err: unknown) {
          throw new Error(
            `Grace after a re-opening: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // The command the recipe will actually send must exist on the equipment,
      // and in close-only mode the value must be one the binding accepts —
      // both are cheap to check now and opaque to debug at 22:30.
      const details = ctx.equipmentManager.getByIdWithDetails(portalId);
      const alias = mode === "close_command" ? readCloseAlias(params) : "command";
      if (details) {
        if (details.orderBindings.length === 0) {
          throw new Error("This portal has no command bound — bind one before scheduling a closure");
        }
        const binding = details.orderBindings.find((ob) => ob.alias === alias);
        if (!binding) {
          const known = details.orderBindings.map((ob) => ob.alias).join(", ");
          throw new Error(`No "${alias}" command on this portal (available: ${known})`);
        }
        const value = readCloseValue(params);
        if (mode === "close_command" && value !== null) {
          const enumValues = binding.enumValues ?? [];
          if (
            enumValues.length > 0 &&
            !enumValues.some(
              (v) => typeof v === "string" && v.toLowerCase() === value.toLowerCase(),
            )
          ) {
            throw new Error(
              `Close value "${value}" is not one of this command's values (${enumValues.join(", ")})`,
            );
          }
        }
      }
    },

    createInstance(params, ctx) {
      const portalId = String(params.portal);
      const closingTime = String(params.closingTime);
      const watchUntil = isValidHHMM(params.watchUntil) ? (params.watchUntil as string) : null;
      const mode = readMode(params.commandMode);
      const doubtPolicy = readDoubtPolicy(params.doubtPolicy);
      const attempts = readAttempts(params.attempts);
      const travelMs = ctx.helpers.parseDuration(params.travelTime ?? "40s");
      const autoCloseMs =
        mode === "pulse_autoclose" ? ctx.helpers.parseDuration(params.autoCloseDelay ?? "2m") : 0;
      const reopenGraceMs =
        params.reopenGrace === undefined || params.reopenGrace === ""
          ? 0
          : ctx.helpers.parseDuration(params.reopenGrace);
      const closeAlias = mode === "close_command" ? readCloseAlias(params) : "command";
      const closeValue = mode === "close_command" ? readCloseValue(params) : null;

      const portalName = (): string => ctx.equipmentManager.getById(portalId)?.name ?? "portail";

      // ── Runtime state ──

      let stopped = false;
      let belief: Belief = "doubt";
      let confirmed = false;
      let lastSensor: PortalState = "unknown";
      let sequenceRunning = false;
      let awaitingConfirmation = false;

      let dailyTimer: ReturnType<typeof setTimeout> | null = null;
      let watchEndTimer: ReturnType<typeof setTimeout> | null = null;
      let reopenTimer: ReturnType<typeof setTimeout> | null = null;
      let sleepTimer: ReturnType<typeof setTimeout> | null = null;
      let sleepResolve: (() => void) | null = null;

      // ── Small utilities ──

      /** A sleep the sensor (or stop()) can cut short. */
      function sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
          sleepResolve = resolve;
          sleepTimer = setTimeout(() => {
            sleepTimer = null;
            sleepResolve = null;
            resolve();
          }, ms);
        });
      }

      function cancelSleep(): void {
        if (sleepTimer) {
          clearTimeout(sleepTimer);
          sleepTimer = null;
        }
        if (sleepResolve) {
          const resolve = sleepResolve;
          sleepResolve = null;
          resolve();
        }
      }

      function readPortal(): PortalState {
        return portalStateOf(ctx.equipmentManager.getByIdWithDetails(portalId));
      }

      function publish(): void {
        ctx.state.set("belief", belief);
        ctx.state.set("confirmed", confirmed);
        ctx.state.set("portalState", lastSensor);
      }

      function setAlarm(on: boolean): void {
        ctx.state.set("alarm", on);
      }

      function nightWatchActive(now: Date = new Date()): boolean {
        return watchUntil !== null && inWindow(closingTime, watchUntil, now);
      }

      function refreshStatus(): void {
        ctx.state.set("status", nightWatchActive() ? "watching" : "idle");
      }

      // ── Beliefs ──

      /** The contact reads closed: the one reading this hardware cannot fake. */
      function markConfirmedClosed(): void {
        const clearing = ctx.state.get("alarm") === true;
        belief = "closed";
        confirmed = true;
        ctx.state.set("lastConfirmedAt", new Date().toISOString());
        setAlarm(false);
        publish();
        if (reopenTimer) {
          clearTimeout(reopenTimer);
          reopenTimer = null;
        }
        if (clearing) ctx.log(`${portalName()} : fermeture confirmée par le capteur, alerte levée`);
        if (awaitingConfirmation) cancelSleep();
      }

      // ── Ordering the portal ──

      function commandLabel(): string {
        if (mode === "close_command") {
          return closeValue === null
            ? `commande de fermeture (${closeAlias})`
            : `commande de fermeture (${closeAlias}=${closeValue})`;
        }
        return "impulsion";
      }

      async function sendCloseCommand(): Promise<boolean> {
        try {
          const res = await ctx.dispatchOrder(portalId, closeAlias, closeValue);
          if (res && res.success === false) {
            ctx.log(`${portalName()} : ${commandLabel()} refusée — ${res.error ?? "échec"}`, "error");
            return false;
          }
          return true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`${portalName()} : ${commandLabel()} impossible — ${msg}`, "error");
          return false;
        }
      }

      /** How long to wait before the contact can be believed again. */
      function settleMs(): number {
        const cycle = mode === "pulse_autoclose" ? travelMs + autoCloseMs + travelMs : travelMs;
        return cycle + CONFIRM_MARGIN_MS;
      }

      /** One manoeuvre: send, wait out the travel, read the contact back. */
      async function manoeuvre(): Promise<{ sent: boolean; confirmed: boolean }> {
        const sent = await sendCloseCommand();
        // Nothing left the engine: no travel to wait out, and no reason to
        // hold the sequence for a minute per attempt on a dead integration.
        if (!sent || stopped) return { sent, confirmed: false };
        awaitingConfirmation = true;
        await sleep(settleMs());
        awaitingConfirmation = false;
        if (stopped) return { sent, confirmed: false };
        const state = readPortal();
        lastSensor = state;
        publish();
        return { sent, confirmed: state === "closed" };
      }

      // ── The closing sequence ──

      /**
       * @param confident true when a real opening was observed, so an impulse
       *        is known to close the portal rather than open it.
       */
      async function runClosure(reason: string, confident: boolean): Promise<void> {
        if (sequenceRunning || stopped) return;

        const state = readPortal();
        lastSensor = state;
        if (state === "closed") {
          markConfirmedClosed();
          refreshStatus();
          ctx.log(`${reason} : ${portalName()} déjà fermé, confirmé par le capteur`);
          return;
        }

        if (mode === "pulse_toggle" && !confident && doubtPolicy === "alert_only") {
          belief = "doubt";
          confirmed = false;
          publish();
          setAlarm(true);
          refreshStatus();
          ctx.log(
            `${reason} : capteur « ouvert » sans preuve d'ouverture — le portail n'est pas manœuvré (politique « alerter seulement »). Vérifiez le portail.`,
            "warn",
          );
          return;
        }

        sequenceRunning = true;
        ctx.state.set("status", "closing");
        ctx.log(
          `${reason} : ${confident || isSafeCommandMode(mode) ? "fermeture" : "recalage"} du ${portalName()} — ${commandLabel()}, ${attempts} tentative(s) max`,
        );

        let pulses = 0;
        let dispatched = false;
        let success = false;

        try {
          for (let attempt = 1; attempt <= attempts && !stopped; attempt++) {
            ctx.state.set("attempt", attempt);
            const result = await manoeuvre();
            if (result.sent) {
              pulses++;
              dispatched = true;
            }
            if (result.confirmed) {
              success = true;
              break;
            }
            if (!result.sent) break; // the integration is not taking orders
            if (!stopped) {
              ctx.log(
                `Tentative ${attempt}/${attempts} : le capteur ne confirme pas la fermeture`,
                "warn",
              );
            }
          }

          if (stopped) return;

          // Nothing confirmed. With an impulse that toggles, the portal's state
          // now depends on the parity of what we sent — pick the one the user
          // asked for rather than leaving it to chance.
          if (!success && mode === "pulse_toggle" && dispatched) {
            const wanted: "odd" | "even" =
              confident || doubtPolicy === "force_close" ? "odd" : "even";
            if (levellingPulses(pulses, wanted) > 0) {
              ctx.log(
                wanted === "even"
                  ? "Impulsion de rattrapage : le portail est remis dans son état initial"
                  : "Impulsion de rattrapage : la séquence se termine sur une manœuvre de fermeture",
              );
              const result = await manoeuvre();
              if (result.sent) pulses++;
              if (result.confirmed) success = true;
            }
          }

          if (!stopped) finish({ success, pulses, dispatched, confident });
        } finally {
          sequenceRunning = false;
          awaitingConfirmation = false;
          if (!stopped) refreshStatus();
        }
      }

      function finish(outcome: {
        success: boolean;
        pulses: number;
        dispatched: boolean;
        confident: boolean;
      }): void {
        const { success, pulses, dispatched, confident } = outcome;
        ctx.state.set("lastClosureAt", new Date().toISOString());
        ctx.state.set("pulses", pulses);

        if (success) {
          markConfirmedClosed();
          ctx.log(`${portalName()} fermé et confirmé par le capteur (${pulses} manœuvre(s))`);
          return;
        }

        if (!dispatched) {
          belief = "doubt";
          confirmed = false;
          publish();
          setAlarm(true);
          ctx.log(
            `${portalName()} : aucune commande n'a pu être envoyée — état inconnu, vérifiez le portail`,
            "error",
          );
          return;
        }

        // A close-only command (or an impulse on a controller that re-closes on
        // its own) means "close" whatever the portal was doing: the manoeuvre is
        // the guarantee, the silent contact is only a sensor fault.
        if (isSafeCommandMode(mode) || confident) {
          belief = "closed";
          confirmed = false;
          publish();
          setAlarm(false);
          ctx.log(
            `${portalName()} : fermeture commandée (${pulses} manœuvre(s)) mais le capteur ne la voit pas — portail réputé fermé, capteur à recaler`,
            "warn",
          );
          return;
        }

        // Impulse mode, in doubt: the portal's state genuinely is unknown.
        belief = "doubt";
        confirmed = false;
        publish();
        setAlarm(true);
        const wanted: "odd" | "even" = doubtPolicy === "force_close" ? "odd" : "even";
        const parityReached = levellingPulses(pulses, wanted) === 0;
        ctx.log(
          !parityReached
            ? `${portalName()} : séquence interrompue après ${pulses} manœuvre(s) — une commande n'est pas passée, état indéterminé, vérifiez le portail`
            : wanted === "odd"
              ? `${portalName()} : séquence terminée sur une fermeture, sans confirmation du capteur — état incertain, vérifiez le portail`
              : `${portalName()} : aucune confirmation après ${pulses} manœuvre(s) — le portail a été remis dans son état initial, vérifiez-le`,
          "warn",
        );
      }

      // ── Schedule ──

      function armDaily(): void {
        if (dailyTimer) clearTimeout(dailyTimer);
        dailyTimer = setTimeout(() => {
          dailyTimer = null;
          runClosure(`Heure de fermeture (${closingTime})`, belief === "open").catch((err) =>
            ctx.logger.error({ err }, "portal-night-closure: closing sequence failed"),
          );
          armDaily();
        }, msUntilTime(closingTime));
        ctx.state.set("nextClosing", closingTime);
      }

      function armWatchEnd(): void {
        if (!watchUntil) return;
        if (watchEndTimer) clearTimeout(watchEndTimer);
        watchEndTimer = setTimeout(() => {
          watchEndTimer = null;
          endWatch();
          armWatchEnd();
        }, msUntilTime(watchUntil));
      }

      /**
       * Morning. An unconfirmed closure does not survive the night: the portal
       * has been reported open all along, so by daylight the recipe is back to
       * knowing nothing rather than to a stale "I closed it myself".
       */
      function endWatch(): void {
        if (belief === "closed" && !confirmed) {
          belief = "doubt";
          publish();
        }
        ctx.state.set("status", "idle");
      }

      function armReopen(): void {
        if (reopenTimer) clearTimeout(reopenTimer);
        reopenTimer = setTimeout(() => {
          reopenTimer = null;
          if (stopped || !nightWatchActive()) return;
          if (readPortal() === "closed") {
            markConfirmedClosed();
            return;
          }
          runClosure("Portail rouvert pendant la nuit", true).catch((err) =>
            ctx.logger.error({ err }, "portal-night-closure: re-closing sequence failed"),
          );
        }, reopenGraceMs);
        ctx.log(
          `${portalName()} ouvert pendant la nuit — fermeture dans ${ctx.helpers.formatDuration(reopenGraceMs)}`,
        );
      }

      // ── Sensor ──

      function onPortalState(next: PortalState): void {
        const previous = lastSensor;
        if (next === previous) return; // the bus re-fires unchanged values
        lastSensor = next;
        ctx.state.set("portalState", next);

        if (next === "closed") {
          markConfirmedClosed();
          return;
        }

        // A closed → open edge is the one opening this hardware reports
        // truthfully. Anything else (open → unknown → open around our own
        // commands) says nothing at all.
        if (next === "open" && previous === "closed") {
          belief = "open";
          confirmed = false;
          publish();
          if (nightWatchActive() && !sequenceRunning) armReopen();
        } else {
          publish();
        }
      }

      // ── Start ──

      const initial = readPortal();
      lastSensor = initial;
      if (initial === "closed") {
        belief = "closed";
        confirmed = true;
      } else {
        // A persisted `open` was a real, observed opening; a persisted
        // `closed` we never confirmed is not worth trusting after a restart.
        belief = ctx.state.get("belief") === "open" ? "open" : "doubt";
        confirmed = false;
      }
      publish();
      if (ctx.state.get("alarm") !== true) setAlarm(false);
      refreshStatus();
      for (const key of ["lastClosureAt", "lastConfirmedAt", "pulses", "attempt"]) {
        if (ctx.state.get(key) === null || ctx.state.get(key) === undefined) {
          ctx.state.set(key, null);
        }
      }

      armDaily();
      armWatchEnd();

      const unsub = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId !== portalId) return;
        if (event.alias !== "state") return;
        const raw = event.value;
        onPortalState(raw === "closed" ? "closed" : raw === "open" ? "open" : "unknown");
      });

      ctx.log(
        `Recette démarrée : ${portalName()} fermé à ${closingTime}` +
          (watchUntil ? `, surveillé jusqu'à ${watchUntil}` : "") +
          ` — ${commandLabel()}, capteur actuellement « ${initial} »`,
      );

      return {
        stop(): void {
          stopped = true;
          if (dailyTimer) clearTimeout(dailyTimer);
          if (watchEndTimer) clearTimeout(watchEndTimer);
          if (reopenTimer) clearTimeout(reopenTimer);
          dailyTimer = null;
          watchEndTimer = null;
          reopenTimer = null;
          cancelSleep();
          unsub();
          ctx.state.set("status", "idle");
          ctx.log("Recette arrêtée — le portail n'est pas manœuvré");
        },
      };
    },
  };
}

// ============================================================
// Param readers shared by validate() and createInstance()
// ============================================================

function readCloseAlias(params: Record<string, unknown>): string {
  const alias = typeof params.closeCommandAlias === "string" ? params.closeCommandAlias.trim() : "";
  return alias === "" ? "command" : alias;
}

function readCloseValue(params: Record<string, unknown>): string | null {
  const value = typeof params.closeCommandValue === "string" ? params.closeCommandValue.trim() : "";
  return value === "" ? null : value;
}
