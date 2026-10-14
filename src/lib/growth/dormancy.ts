// Win-back dormancy detection — pure functions (no DB, no network).
//
// A contact is "dormant" when it has seen no commercial or
// conversational activity for at least `dormancyDays`:
//   lastActivityAt = max(last invoice, last payment, last inbound message)
// A contact with NO activity ever is dormant only if its created_at
// is older than the dormancy window (so brand-new contacts are not
// instantly win-backed).

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface DormancyInput {
  /** ISO instant of the most recent invoice/payment/inbound message. */
  lastActivityAt: string | null;
  /** Fallback when there is no activity at all. */
  createdAt: string | null;
}

/** True when the contact has been inactive for >= dormancyDays. */
export function isDormant(
  input: DormancyInput,
  dormancyDays: number,
  now: Date = new Date(),
): boolean {
  if (!Number.isInteger(dormancyDays) || dormancyDays < 0) {
    throw new Error(`dormancyDays must be a non-negative integer, got ${dormancyDays}`);
  }
  const anchor = input.lastActivityAt ?? input.createdAt;
  if (!anchor) return false; // no timestamps at all — never auto-enroll
  const anchorMs = new Date(anchor).getTime();
  if (!Number.isFinite(anchorMs) || anchorMs > now.getTime()) return false;
  return now.getTime() - anchorMs >= dormancyDays * DAY_MS;
}

/** True when the contact was enrolled/opted-out recently enough to
 *  skip re-nagging (winback_exclude_recent_days window). */
export function recentlyEngagedByWinback(
  lastWinbackEventAt: string | null,
  excludeRecentDays: number,
  now: Date = new Date(),
): boolean {
  if (!lastWinbackEventAt) return false;
  if (excludeRecentDays <= 0) return false;
  const t = new Date(lastWinbackEventAt).getTime();
  if (!Number.isFinite(t) || t > now.getTime()) return false;
  return now.getTime() - t < excludeRecentDays * DAY_MS;
}

/** Latest of several nullable ISO instants (null when all null). */
export function maxInstant(...instants: Array<string | null>): string | null {
  let best: number | null = null;
  for (const s of instants) {
    if (!s) continue;
    const t = new Date(s).getTime();
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}
