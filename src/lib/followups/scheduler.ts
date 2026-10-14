// Drip follow-up scheduler — pure functions (no DB, no network).
//
// All scheduling rules live here so they are unit-testable:
//   - opt-out keyword detection (STOP / UNSUBSCRIBE)
//   - template variable rendering ({{name}}, {{business}})
//   - quiet-hours windows in a configurable IANA timezone
//   - day-offset due-date math from the enrollment date
//   - due-enrollment selection and daily send-cap gating
//
// Time-zone math is done with Intl only (no date library): quiet
// windows are evaluated on the contact-local clock, and "today" for
// daily caps is the contact-local calendar day.

export interface QuietConfig {
  quietStart: string; // 'HH:MM' 24h
  quietEnd: string; // 'HH:MM' 24h
  timezone: string; // IANA, e.g. 'Asia/Kolkata'
}

export interface SequenceLike extends QuietConfig {
  active: boolean;
  dailySendCap: number; // 0 = unlimited
}

export interface EnrollmentLike {
  status: string; // 'active' | 'paused' | 'completed' | 'opted_out' | 'cancelled'
  nextDueAt: string | null;
  currentStep: number;
}

// ----------------------------------------------------------------
// Opt-out keywords
// ----------------------------------------------------------------

/** Tokens that always mean "stop messaging me". Word-token match on
 *  the uppercased message, so "please STOP sending" also opts out —
 *  over-opting-out is the safe failure mode for compliance. */
const OPTOUT_TOKENS = new Set(["STOP", "UNSUBSCRIBE"]);

export function isOptOut(text: string | null | undefined): boolean {
  if (!text) return false;
  const tokens = text.toUpperCase().split(/[^A-Z]+/);
  return tokens.some((t) => OPTOUT_TOKENS.has(t));
}

// ----------------------------------------------------------------
// Template rendering
// ----------------------------------------------------------------

export interface TemplateVars {
  name?: string | null;
  business?: string | null;
}

/** Replace {{name}} / {{business}} (whitespace-tolerant, case-insensitive).
 *  Unknown variables are left untouched; missing values render as "". */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/{{\s*([a-zA-Z]+)\s*}}/g, (_match, key: string) => {
    const k = key.toLowerCase();
    if (k === "name") return vars.name ?? "";
    if (k === "business") return vars.business ?? "";
    return _match;
  });
}

// ----------------------------------------------------------------
// Time-zone helpers (Intl only)
// ----------------------------------------------------------------

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`invalid HH:MM: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid HH:MM: ${hhmm}`);
  return h * 60 + min;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(date: Date, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Offset of `timezone` from UTC, in minutes, at `date`. */
function tzOffsetMinutes(date: Date, timezone: string): number {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Seconds are dropped by the formatter; the offset is only ever a
  // whole number of minutes away from the truncated value.
  return Math.round((asUtc - date.getTime()) / 60000);
}

// ----------------------------------------------------------------
// Quiet hours
// ----------------------------------------------------------------

/** True when `date` falls inside the quiet window on the local clock.
 *  Handles overnight windows (start > end, e.g. 21:00 → 09:00) and
 *  treats start === end as "no quiet hours". */
export function isQuietHours(date: Date, quiet: QuietConfig): boolean {
  const start = toMinutes(quiet.quietStart);
  const end = toMinutes(quiet.quietEnd);
  if (start === end) return false;
  const p = localParts(date, quiet.timezone);
  const nowMin = p.hour * 60 + p.minute;
  if (start < end) {
    return nowMin >= start && nowMin < end;
  }
  // Overnight: quiet from start → midnight → end.
  return nowMin >= start || nowMin < end;
}

/** Push `date` forward to the end of the quiet window when it falls
 *  inside one; otherwise return it unchanged. The returned instant is
 *  the local quiet-end time on the same local day. */
export function shiftPastQuietHours(date: Date, quiet: QuietConfig): Date {
  const start = toMinutes(quiet.quietStart);
  const end = toMinutes(quiet.quietEnd);
  if (!isQuietHours(date, quiet)) return date;
  const p = localParts(date, quiet.timezone);
  const nowMin = p.hour * 60 + p.minute;
  // Minutes until the window ends on the local clock.
  const delta = start < end ? end - nowMin : end + 1440 - nowMin;
  return new Date(date.getTime() + delta * 60000);
}

/** Start of the local calendar day containing `date`, as a UTC instant. */
export function startOfDayInZone(date: Date, timezone: string): Date {
  const p = localParts(date, timezone);
  const offset = tzOffsetMinutes(date, timezone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - offset * 60000);
}

// ----------------------------------------------------------------
// Due-date math
// ----------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;

/** When step `dayOffset` days after `enrolledAt` becomes sendable:
 *  same wall-clock time as enrollment, pushed past quiet hours. */
export function computeStepDue(
  enrolledAt: Date,
  dayOffset: number,
  quiet: QuietConfig,
): Date {
  if (!Number.isInteger(dayOffset) || dayOffset < 0) {
    throw new Error(`dayOffset must be a non-negative integer, got ${dayOffset}`);
  }
  const raw = new Date(enrolledAt.getTime() + dayOffset * DAY_MS);
  return shiftPastQuietHours(raw, quiet);
}

// ----------------------------------------------------------------
// Selection
// ----------------------------------------------------------------

export interface DueSelection {
  /** Ready to attempt right now. */
  due: EnrollmentLike[];
  /** Due but currently inside quiet hours — leave next_due_at alone;
   *  the next cron tick retries. */
  deferredQuiet: EnrollmentLike[];
}

/** Split enrollments into "send now" vs "wait out quiet hours". Only
 *  active enrollments with next_due_at <= now are considered. */
export function selectDueEnrollments<T extends EnrollmentLike>(
  enrollments: T[],
  now: Date,
  quiet: QuietConfig,
): DueSelection & { due: T[]; deferredQuiet: T[] } {
  const due: T[] = [];
  const deferredQuiet: T[] = [];
  for (const e of enrollments) {
    if (e.status !== "active") continue;
    if (!e.nextDueAt) continue;
    if (new Date(e.nextDueAt).getTime() > now.getTime()) continue;
    if (isQuietHours(now, quiet)) deferredQuiet.push(e);
    else due.push(e);
  }
  return { due, deferredQuiet };
}

/** Daily cap gate: cap <= 0 means unlimited. */
export function withinDailyCap(sentToday: number, cap: number): boolean {
  if (cap <= 0) return true;
  return sentToday < cap;
}

// ----------------------------------------------------------------
// Inbound disposition (pure decision — the DB write lives in inbound.ts)
// ----------------------------------------------------------------

export type InboundDisposition = "opt_out" | "pause" | "none";

/** Decide what an inbound message does to the contact's active
 *  enrollments. Opt-out wins over pause; no active enrollments →
 *  'none'. */
export function inboundDisposition(
  text: string | null | undefined,
  activeEnrollmentCount: number,
): InboundDisposition {
  if (activeEnrollmentCount <= 0) return "none";
  if (isOptOut(text)) return "opt_out";
  return "pause";
}
