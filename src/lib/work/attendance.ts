// Attendance + task helpers — pure functions for Module 4.
// DB enforcement (one row per account/user/day) lives in the
// 042 migration's unique index; these helpers build the payloads
// and guard the client-visible invariants.

export type AttendanceStatus = "present" | "absent" | "half_day" | "leave";

const STATUSES: AttendanceStatus[] = ["present", "absent", "half_day", "leave"];

export function isAttendanceStatus(v: unknown): v is AttendanceStatus {
  return typeof v === "string" && (STATUSES as string[]).includes(v);
}

export interface AttendanceRowLike {
  check_in_at: string | null;
  check_out_at: string | null;
}

export type AttendanceAction = "check_in" | "check_out" | "set_status";

/**
 * Build the upsert payload for an attendance action. Throws an
 * Error with a user-facing message when the action is invalid
 * against the current row (e.g. checking out with no check-in).
 *
 * - check_in:  stamps check_in_at (keeps the first check-in of
 *   the day), forces status to "present".
 * - check_out: stamps check_out_at; requires an existing row with
 *   a check_in_at, and the new stamp must not precede check-in.
 * - set_status: sets an explicit status (leave, absent, …); a
 *   caller clearing a day's mistake passes status + null stamps.
 */
export function buildAttendanceUpsert(
  action: AttendanceAction,
  existing: AttendanceRowLike | null,
  opts: { nowIso: string; status?: unknown },
): Record<string, unknown> {
  if (action === "check_in") {
    return {
      status: "present" as AttendanceStatus,
      // First check-in of the day wins — a second tap doesn't
      // overwrite the morning stamp.
      check_in_at: existing?.check_in_at ?? opts.nowIso,
    };
  }
  if (action === "check_out") {
    if (!existing || !existing.check_in_at) {
      throw new Error("Cannot check out before checking in");
    }
    if (new Date(opts.nowIso) < new Date(existing.check_in_at)) {
      throw new Error("Check-out time cannot be before check-in time");
    }
    return { check_out_at: opts.nowIso };
  }
  // set_status
  if (!isAttendanceStatus(opts.status)) {
    throw new Error("status must be present, absent, half_day, or leave");
  }
  return { status: opts.status };
}

/**
 * Whether `userId` may write an attendance row for `targetUserId`
 * without admin rights: self-service is always allowed.
 */
export function canSelfManageAttendance(
  callerUserId: string,
  targetUserId: string,
): boolean {
  return callerUserId === targetUserId;
}

/**
 * A task needs a nudge when its reminder time has passed and it
 * is still open. Null reminder_at = no reminder requested.
 */
export function taskReminderDue(
  task: { reminder_at: string | null; done: boolean },
  nowIso: string,
): boolean {
  if (task.done || task.reminder_at === null) return false;
  return new Date(task.reminder_at).getTime() <= new Date(nowIso).getTime();
}

/**
 * Validate a "YYYY-MM" month selector. Returns the normalized
 * value or throws with a user-facing message.
 */
export function parseMonthParam(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) {
    throw new Error("month must be YYYY-MM");
  }
  return v;
}

/**
 * Validate a "YYYY-MM-DD" date string (calendar-plausible; the
 * regex plus a round-trip check rejects 2026-02-30 style dates).
 */
export function parseDateParam(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error("date must be YYYY-MM-DD");
  const roundTrip = d.toISOString().slice(0, 10);
  if (roundTrip !== v) throw new Error("date must be a real calendar date");
  return v;
}
