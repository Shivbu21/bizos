// AI lead scoring — rules-based v1, fully transparent.
//
// This is deliberately NOT a black-box model: every weight is a
// named constant below, the breakdown is stored with every score,
// and the whole table is printed in MODULE5.md so the scoring is
// auditable by anyone. Pure functions (no DB, no network) —
// unit-tested in scoring.test.ts.
//
// Total: 100 points across four signals.

export interface LeadScoreInput {
  /** Normalized source slug, e.g. 'whatsapp', 'instagram',
   *  'facebook', 'web_form', 'justdial', 'import', 'manual'. */
  source: string | null;
  /** Number of inbound messages from this lead/contact. */
  inboundMessageCount: number;
  /** ISO instant of the most recent inbound message, if any. */
  lastInboundAt: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  /** Lead pipeline status. */
  status: string | null;
}

export interface ScoreBreakdown {
  source: number;
  engagement: number;
  profile: number;
  stage: number;
}

export interface LeadScore {
  score: number; // 0–100
  breakdown: ScoreBreakdown;
}

// ----------------------------------------------------------------
// Weights — the auditable table. Change these and the tests +
// MODULE5.md must change with them.
// ----------------------------------------------------------------

/** Source quality: warmer intent scores higher. Max 25. */
export const SOURCE_WEIGHTS: Record<string, number> = {
  whatsapp: 25, // click-to-chat / direct conversation
  instagram: 20, // comment-to-DM trigger
  facebook: 18, // Lead Ads
  web_form: 15, // website contact form
  justdial: 12, // directory listing
  import: 8, // CSV import
  manual: 8, // hand-entered
};
export const SOURCE_WEIGHT_DEFAULT = 5;
export const SOURCE_WEIGHT_MAX = 25;

/** Engagement: message volume + recency. Max 30. */
export const ENGAGEMENT_VOLUME_TIERS: Array<{ min: number; points: number }> = [
  { min: 6, points: 25 },
  { min: 3, points: 20 },
  { min: 1, points: 10 },
  { min: 0, points: 0 },
];
/** Bonus when the last inbound message is fresh. */
export const ENGAGEMENT_RECENCY_DAYS = 7;
export const ENGAGEMENT_RECENCY_POINTS = 5;
export const ENGAGEMENT_MAX = 30;

/** Profile completeness. Max 20. */
export const PROFILE_WEIGHTS = { name: 7, phone: 7, email: 6 } as const;
export const PROFILE_MAX = 20;

/** Pipeline stage. Max 25. */
export const STAGE_WEIGHTS: Record<string, number> = {
  new: 5,
  contacted: 12,
  qualified: 20,
  converted: 25,
  lost: 0,
};
export const STAGE_WEIGHT_DEFAULT = 0;
export const STAGE_MAX = 25;

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function scoreSource(source: string | null): number {
  if (!source) return SOURCE_WEIGHT_DEFAULT;
  const key = source.trim().toLowerCase();
  return SOURCE_WEIGHTS[key] ?? SOURCE_WEIGHT_DEFAULT;
}

export function scoreEngagement(
  inboundMessageCount: number,
  lastInboundAt: string | null,
  now: Date = new Date(),
): number {
  const count = Math.max(0, Math.floor(inboundMessageCount || 0));
  let points = 0;
  for (const tier of ENGAGEMENT_VOLUME_TIERS) {
    if (count >= tier.min) {
      points = tier.points;
      break;
    }
  }
  if (lastInboundAt) {
    const last = new Date(lastInboundAt).getTime();
    if (
      Number.isFinite(last) &&
      now.getTime() - last <= ENGAGEMENT_RECENCY_DAYS * 24 * 60 * 60 * 1000 &&
      last <= now.getTime()
    ) {
      points += ENGAGEMENT_RECENCY_POINTS;
    }
  }
  return Math.min(points, ENGAGEMENT_MAX);
}

export function scoreProfile(
  name: string | null,
  phone: string | null,
  email: string | null,
): number {
  let points = 0;
  if (name && name.trim()) points += PROFILE_WEIGHTS.name;
  if (phone && phone.trim()) points += PROFILE_WEIGHTS.phone;
  if (email && email.trim()) points += PROFILE_WEIGHTS.email;
  return Math.min(points, PROFILE_MAX);
}

export function scoreStage(status: string | null): number {
  if (!status) return STAGE_WEIGHT_DEFAULT;
  const key = status.trim().toLowerCase();
  return STAGE_WEIGHTS[key] ?? STAGE_WEIGHT_DEFAULT;
}

/** Score a lead 0–100 with a full breakdown. Deterministic. */
export function scoreLead(input: LeadScoreInput, now: Date = new Date()): LeadScore {
  const breakdown: ScoreBreakdown = {
    source: clampInt(scoreSource(input.source), 0, SOURCE_WEIGHT_MAX),
    engagement: clampInt(
      scoreEngagement(input.inboundMessageCount, input.lastInboundAt, now),
      0,
      ENGAGEMENT_MAX,
    ),
    profile: clampInt(
      scoreProfile(input.name, input.phone, input.email),
      0,
      PROFILE_MAX,
    ),
    stage: clampInt(scoreStage(input.status), 0, STAGE_MAX),
  };
  const score = clampInt(
    breakdown.source + breakdown.engagement + breakdown.profile + breakdown.stage,
    0,
    100,
  );
  return { score, breakdown };
}

/** Human-readable band for badge colors. */
export function scoreBand(score: number): "hot" | "warm" | "cold" {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}
