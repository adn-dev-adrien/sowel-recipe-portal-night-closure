// ============================================================
// Automatic Portal Closure — external Sowel recipe
//
// Two ways of asking for the same thing — a portal that does not stay open:
//
//   • an ARMED MODE. While it is on, every opening — the remote, the keypad,
//     a delivery, whoever — starts a grace delay and ends in a closure. It is
//     switched from the Dashboard tile, or on a schedule.
//   • the EVENING CLOSURE, at a chosen hour: the portal is closed for the
//     night, whether or not anyone thought about it.
//
// Both feed ONE watcher, on purpose. On a portal driven by an impulse that
// toggles, two automations each holding their own deadline send two impulses
// for one opening: the first closes, the second re-opens. One watcher, one
// pending closure, is the only shape that cannot do that.
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
// The grace delay is the same in both jobs: whoever just opened the portal is
// given `reopenGrace` before it closes again. After the closing hour the recipe
// keeps an eye out until `watchUntil`, so coming home at midnight does not
// leave the portal open till morning; with the mode armed it watches all day
// too. The pending closure feeds a live countdown on the row and on the tile.
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
  /** Core spec 174: the deadline the engine itself holds on this equipment. */
  timedAction?: { alias?: string; revertValue?: unknown; expiresAt?: string } | null;
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

interface RecipeActionDef {
  id: string;
  type: "cycle";
  stateKey: string;
  options: { value: string; label: string }[];
}

/** Opt-in Dashboard tile (core spec 169, >= 1.64.0). Ignored by older cores. */
interface RecipeTileDef {
  icon?: string;
  summaryKey?: string;
  countdownKey?: string;
  actions?: string[];
  confirm?: boolean;
  confirmParam?: string;
  confirmFrom?: string;
}

interface RecipeInstanceHandle {
  stop(): void;
  onAction?(action: string, payload?: Record<string, unknown>): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: RecipeActionDef[];
  tile?: RecipeTileDef;
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

/**
 * The armed auto-closing mode: while it is on, EVERY opening — the remote, the
 * keypad, a delivery, whoever — starts the grace delay and ends in a closure.
 * It is on top of the nightly window, not instead of it: both feed the same
 * single watcher, so the portal never receives two impulses for one opening.
 */
export type AutoCloseMode = "off" | "on";

/** Margin added to the travel time before reading the contact back. */
const CONFIRM_MARGIN_MS = 10_000;

const MODE_OPTIONS = [
  { value: "pulse_toggle", label: "Impulse (sequential toggle)" },
  { value: "pulse_autoclose", label: "Impulse + automatic re-closing" },
  { value: "close_command", label: "Dedicated close command" },
];

/**
 * The mode is a plain on/off: a cycle action with two options is a toggle, and
 * one click on the Dashboard tile flips it.
 */
const AUTO_CLOSE_OPTIONS = [
  { value: "off", label: "Arrêt" },
  { value: "on", label: "Armé" },
];

/**
 * The grace is a short list rather than a free duration: it is read at a glance
 * on a tile, and the four values below are the ones that make sense between
 * "the visitor is still in the driveway" and "they have had time to leave".
 * The values are duration strings, so an instance that already stored `10m`
 * keeps working untouched.
 */
const GRACE_OPTIONS = [
  { value: "1m", label: "1 minute" },
  { value: "3m", label: "3 minutes" },
  { value: "5m", label: "5 minutes" },
  { value: "10m", label: "10 minutes" },
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

export function readAutoCloseMode(value: unknown): AutoCloseMode {
  return value === "on" ? "on" : "off";
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
      name: "Delay before re-closing",
      description:
        "Time left to whoever just opened the portal before it is closed again. Used by the armed mode and by the night watch alike.",
      type: "select",
      required: false,
      defaultValue: "10m",
      options: GRACE_OPTIONS,
      group: "schedule",
    },
    {
      id: "autoCloseFrom",
      name: "Arm the mode at",
      description:
        "Switch the automatic closing mode on at this time, every day. Leave empty to only arm it by hand from the Dashboard.",
      type: "time",
      required: false,
      defaultValue: "",
      group: "autoclose",
    },
    {
      id: "autoCloseUntil",
      name: "Disarm the mode at",
      description:
        "Switch the mode back off at this time. Leave empty to leave it armed until you switch it off yourself.",
      type: "time",
      required: false,
      defaultValue: "",
      group: "autoclose",
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
  name: "Fermeture automatique de portail",
  description:
    "Referme le portail tout seul : un mode armable qui referme après chaque ouverture, et la fermeture garantie du soir — sur une installation dont le seul capteur est un contact de fermeture qui rate parfois la détection.",
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
      name: "Délai avant refermeture",
      description:
        "Temps laissé à celui qui vient d'ouvrir le portail avant de le refermer. Sert au mode armé comme à la veille de nuit.",
      options: {
        "1m": "1 minute",
        "3m": "3 minutes",
        "5m": "5 minutes",
        "10m": "10 minutes",
      },
    },
    autoCloseFrom: {
      name: "Armer le mode à",
      description:
        "Active le mode fermeture automatique à cette heure, tous les jours. Vide = le mode ne s'arme qu'à la main, depuis le tableau de bord.",
    },
    autoCloseUntil: {
      name: "Désarmer le mode à",
      description:
        "Coupe le mode à cette heure. Vide = le mode reste armé jusqu'à ce que vous le coupiez vous-même.",
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
  groups: {
    schedule: "Horaires",
    autoclose: "Mode fermeture automatique",
    command: "Commande du portail",
    doubt: "En cas de doute",
  },
};

// ============================================================
// Recipe
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    // The id is deliberately unchanged: instances are stored by recipe id, so
    // renaming it would strand the installed one. The recipe grew a second job,
    // it did not become a different recipe.
    id: "portal-night-closure",
    name: "Automatic Portal Closure",
    description:
      "Closes the portal on its own: an armable mode that re-closes after every opening, plus the guaranteed evening closure — on an installation whose only sensor is a closed-contact that sometimes misses the closure.",
    slots: buildSlots(),

    actions: [
      {
        id: "set_auto_close",
        type: "cycle",
        stateKey: "autoClose",
        options: AUTO_CLOSE_OPTIONS,
      },
    ],

    // Dashboard tile (core spec 169). Two options on the cycle action make it a
    // toggle: one click anywhere on the card arms or disarms the mode.
    //
    // No `confirm` / `confirmFrom` here, on purpose. Those guard a click that
    // MOVES the equipment; this one only arms a watch, and nothing leaves for
    // the portal until it is opened and the grace runs out. Deriving the guard
    // from the portal (whose "Confirmation before action" is on) would demand a
    // slide every time the mode is switched, for a click that moves nothing.
    tile: {
      icon: "DoorClosed",
      actions: ["set_auto_close"],
    },

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

      for (const id of ["autoCloseFrom", "autoCloseUntil"] as const) {
        const value = params[id];
        if (value === undefined || value === "" || value === null) continue;
        if (!isValidHHMM(value)) throw new Error(`${id} must be a valid HH:MM time, or empty`);
      }
      const armAt = isValidHHMM(params.autoCloseFrom) ? params.autoCloseFrom : null;
      const disarmAt = isValidHHMM(params.autoCloseUntil) ? params.autoCloseUntil : null;
      if (disarmAt !== null && armAt === null) {
        // A disarm hour on its own would silently switch off a mode nothing
        // ever switches on — the setting reads like an automation and is none.
        throw new Error("A disarm time needs an arm time — set both, or neither");
      }
      if (armAt !== null && armAt === disarmAt) {
        throw new Error("Arm and disarm times must differ");
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
      const autoCloseFrom = isValidHHMM(params.autoCloseFrom)
        ? (params.autoCloseFrom as string)
        : null;
      const autoCloseUntil = isValidHHMM(params.autoCloseUntil)
        ? (params.autoCloseUntil as string)
        : null;
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
      // The last thing the contact said for sure. Sowel parks the state on
      // `unknown` while any command it sent is in flight, so an opening asked
      // from a phone or a tile reads closed → unknown → open.
      let lastSettled: PortalState = "unknown";
      let sequenceRunning = false;
      let awaitingConfirmation = false;

      let autoClose: AutoCloseMode = "off";

      let dailyTimer: ReturnType<typeof setTimeout> | null = null;
      let watchEndTimer: ReturnType<typeof setTimeout> | null = null;
      let armTimer: ReturnType<typeof setTimeout> | null = null;
      let disarmTimer: ReturnType<typeof setTimeout> | null = null;
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

      function graceLabel(): string {
        return ctx.helpers.formatDuration(reopenGraceMs);
      }

      function publish(): void {
        ctx.state.set("belief", belief);
        ctx.state.set("confirmed", confirmed);
        ctx.state.set("portalState", lastSensor);
        ctx.state.set("autoClose", autoClose);
        ctx.state.set("summary", summaryLine());
      }

      function setAlarm(on: boolean): void {
        ctx.state.set("alarm", on);
        // The summary reads the alarm, and several callers raise it *after*
        // publishing — refresh it here so the line is never a step behind.
        ctx.state.set("summary", summaryLine());
      }

      function nightWatchActive(now: Date = new Date()): boolean {
        return watchUntil !== null && inWindow(closingTime, watchUntil, now);
      }

      /**
       * The single predicate that decides whether an opening is watched. The
       * armed mode and the nightly window both answer it, which is precisely
       * why there is one watcher and never two impulses for one opening.
       */
      function watchActive(now: Date = new Date()): boolean {
        return autoClose === "on" || nightWatchActive(now);
      }

      function refreshStatus(): void {
        ctx.state.set("status", watchActive() ? "watching" : "idle");
      }

      /** The one line the recipe row and the Dashboard tile show. */
      function summaryLine(): string {
        if (ctx.state.get("alarm") === true) return "État incertain — vérifiez le portail";
        if (sequenceRunning) return "Fermeture en cours…";
        const place =
          belief === "closed"
            ? confirmed
              ? "Fermé"
              : "Réputé fermé"
            : belief === "open"
              ? "Ouvert"
              : "État inconnu";
        // A pending closure already has the countdown next to it: the line says
        // what is happening, the countdown says when.
        if (reopenTimer) return `${place} — refermeture automatique`;
        if (autoClose === "on") return `${place} — mode armé, refermeture ${graceLabel()} après ouverture`;
        if (nightWatchActive()) return `${place} — veille de nuit, refermeture ${graceLabel()} après ouverture`;
        return `${place} — mode au repos, fermeture à ${closingTime}`;
      }

      // ── Beliefs ──

      /** The contact reads closed: the one reading this hardware cannot fake. */
      function markConfirmedClosed(): void {
        const clearing = ctx.state.get("alarm") === true;
        belief = "closed";
        confirmed = true;
        ctx.state.set("lastConfirmedAt", new Date().toISOString());
        // Cancel before publishing: the summary reads the pending timer.
        clearReopen();
        setAlarm(false);
        publish();
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
        if (state !== "unknown") lastSettled = state;
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
        if (state !== "unknown") lastSettled = state;
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
        // Not a bare "idle": the armed mode outlives the night window.
        refreshStatus();
      }

      /**
       * The deadline the CORE holds on this portal (spec 174, "open for 15 min"
       * from the equipment's own tile), if any.
       *
       * It sends the very same impulse this recipe would. The core cannot see
       * ours and stand down — its rule 2 needs a mirror binding, and a gate's
       * sequential impulse has none, as its own code says. So the recipe is the
       * one that gives way: two deadlines on one opening means the first closes
       * the portal and the second RE-OPENS it.
       *
       * Giving way is also the right answer on the merits: "open for 15 minutes"
       * is an explicit request, made just now, by a person. The standing mode is
       * a default. The explicit one wins.
       */
      function coreDeadline(): string | null {
        const details = ctx.equipmentManager.getByIdWithDetails(portalId);
        const expiresAt = details?.timedAction?.expiresAt;
        return typeof expiresAt === "string" ? expiresAt : null;
      }

      function clearReopen(): void {
        if (reopenTimer) {
          clearTimeout(reopenTimer);
          reopenTimer = null;
        }
        ctx.state.set("timerExpiresAt", null);
      }

      function armReopen(): void {
        const armedByMode = autoClose === "on";
        clearReopen();

        const core = coreDeadline();
        if (core !== null) {
          publish();
          ctx.log(
            `${portalName()} ouvert — la minuterie du portail est déjà armée (échéance ${core}), la recette la laisse fermer`,
          );
          return;
        }

        reopenTimer = setTimeout(() => {
          reopenTimer = null;
          ctx.state.set("timerExpiresAt", null);
          // Re-checked at the deadline, not only when arming: the mode may have
          // been switched off, or the night watch ended, in between.
          if (stopped || !watchActive()) {
            publish();
            return;
          }
          // Re-checked here too: the portal's own timer may have been armed
          // from its tile after this closure was scheduled.
          const core = coreDeadline();
          if (core !== null) {
            publish();
            ctx.log(
              `${portalName()} : minuterie du portail armée entre-temps (échéance ${core}) — la recette la laisse fermer`,
            );
            return;
          }
          if (readPortal() === "closed") {
            markConfirmedClosed();
            return;
          }
          // Read now, not at arming time: the mode may have been switched off
          // while the night watch kept the closure alive, and the journal
          // should name the reason that actually survived.
          runClosure(
            autoClose === "on" ? "Mode fermeture automatique" : "Portail rouvert pendant la nuit",
            true,
          ).catch((err) =>
            ctx.logger.error({ err }, "portal-night-closure: re-closing sequence failed"),
          );
        }, reopenGraceMs);
        // Feeds the amber countdown on the recipe row and on the tile.
        ctx.state.set("timerExpiresAt", new Date(Date.now() + reopenGraceMs).toISOString());
        publish();
        ctx.log(
          `${portalName()} ouvert (${armedByMode ? "mode armé" : "veille de nuit"}) — fermeture dans ${graceLabel()}`,
        );
      }

      // ── The armed mode ──

      /**
       * The one writer of the mode. The pill, the schedule and the restart all
       * come through here, so arming means the same thing whoever asked.
       */
      function setAutoClose(next: AutoCloseMode, source: string): void {
        if (next === autoClose) return;
        autoClose = next;

        if (next === "on") {
          ctx.log(
            `Mode fermeture automatique armé (${source}) — refermeture ${graceLabel()} après chaque ouverture`,
          );
          // Arming on a portal already open: act only on the certainty of an
          // observed opening. A bare "open" contact may be a closed portal
          // short of its reed, and an impulse on that one would OPEN it.
          if (belief === "open" && !sequenceRunning && !reopenTimer) armReopen();
          else publish();
        } else {
          // The night watch is a second reason to be watching: only drop a
          // pending closure if the mode was the only thing holding it.
          const dropping = reopenTimer !== null && !nightWatchActive();
          if (dropping) clearReopen();
          ctx.log(
            `Mode fermeture automatique coupé (${source})` +
              (dropping ? " — refermeture en attente annulée" : ""),
          );
          publish();
        }
        refreshStatus();
      }

      function armAutoCloseOn(): void {
        if (!autoCloseFrom) return;
        if (armTimer) clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armTimer = null;
          if (!stopped) setAutoClose("on", `programmation ${autoCloseFrom}`);
          armAutoCloseOn();
        }, msUntilTime(autoCloseFrom));
      }

      function armAutoCloseOff(): void {
        if (!autoCloseUntil) return;
        if (disarmTimer) clearTimeout(disarmTimer);
        disarmTimer = setTimeout(() => {
          disarmTimer = null;
          if (!stopped) setAutoClose("off", `programmation ${autoCloseUntil}`);
          armAutoCloseOff();
        }, msUntilTime(autoCloseUntil));
      }

      // ── Sensor ──

      function onPortalState(next: PortalState): void {
        if (next === lastSensor) return; // the bus re-fires unchanged values
        lastSensor = next;
        const settled = lastSettled;
        if (next !== "unknown") lastSettled = next;
        ctx.state.set("portalState", next);

        if (next === "closed") {
          markConfirmedClosed();
          return;
        }

        // Closed → open is the one opening this hardware reports truthfully,
        // with or without Sowel's `unknown` in between. Open → unknown → open
        // (around our own commands) says nothing at all.
        if (next === "open" && settled === "closed") {
          belief = "open";
          confirmed = false;
          publish();
          if (watchActive() && !sequenceRunning) armReopen();
        } else {
          publish();
        }
      }

      // ── Start ──

      const initial = readPortal();
      lastSensor = initial;
      lastSettled = initial;
      if (initial === "closed") {
        belief = "closed";
        confirmed = true;
      } else {
        // A persisted `open` was a real, observed opening; a persisted
        // `closed` we never confirmed is not worth trusting after a restart.
        belief = ctx.state.get("belief") === "open" ? "open" : "doubt";
        confirmed = false;
      }

      // The mode survives a restart. A schedule outranks what was persisted:
      // inside its window, the mode belongs on whatever a restart lost.
      autoClose = readAutoCloseMode(ctx.state.get("autoClose"));
      if (autoCloseFrom && autoCloseUntil && inWindow(autoCloseFrom, autoCloseUntil)) {
        autoClose = "on";
      }

      // No closure is armed here, even on a portal reading open with the mode
      // on. Arming from the pill is a deliberate gesture, made by someone in
      // front of the portal; a restart is not, and an impulse nobody asked for
      // at 3 a.m. would be the worst thing this recipe could do. The next real
      // opening is what re-arms it.
      publish();
      if (ctx.state.get("alarm") !== true) setAlarm(false);
      refreshStatus();
      // Never inherited: a stale deadline would render a countdown for a timer
      // that no longer exists.
      ctx.state.set("timerExpiresAt", null);
      for (const key of ["lastClosureAt", "lastConfirmedAt", "pulses", "attempt"]) {
        if (ctx.state.get(key) === null || ctx.state.get(key) === undefined) {
          ctx.state.set(key, null);
        }
      }

      armDaily();
      armWatchEnd();
      armAutoCloseOn();
      armAutoCloseOff();

      const unsub = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId !== portalId) return;
        if (event.alias !== "state") return;
        const raw = event.value;
        onPortalState(raw === "closed" ? "closed" : raw === "open" ? "open" : "unknown");
      });

      ctx.log(
        `Recette démarrée : ${portalName()} fermé à ${closingTime}` +
          (watchUntil ? `, surveillé jusqu'à ${watchUntil}` : "") +
          ` — mode fermeture automatique ${autoClose === "on" ? "armé" : "au repos"}` +
          (autoCloseFrom ? ` (programmé ${autoCloseFrom}${autoCloseUntil ? `→${autoCloseUntil}` : ""})` : "") +
          `, refermeture ${graceLabel()} après ouverture` +
          ` — ${commandLabel()}, capteur actuellement « ${initial} »`,
      );

      return {
        stop(): void {
          stopped = true;
          if (dailyTimer) clearTimeout(dailyTimer);
          if (watchEndTimer) clearTimeout(watchEndTimer);
          if (reopenTimer) clearTimeout(reopenTimer);
          if (armTimer) clearTimeout(armTimer);
          if (disarmTimer) clearTimeout(disarmTimer);
          dailyTimer = null;
          watchEndTimer = null;
          reopenTimer = null;
          armTimer = null;
          disarmTimer = null;
          cancelSleep();
          unsub();
          ctx.state.set("status", "idle");
          ctx.state.set("timerExpiresAt", null);
          ctx.log("Recette arrêtée — le portail n'est pas manœuvré");
        },

        onAction(action: string, payload?: Record<string, unknown>): void {
          if (action !== "set_auto_close") return;
          setAutoClose(readAutoCloseMode(payload?.mode), "tableau de bord");
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
