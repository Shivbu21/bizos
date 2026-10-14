// Unit tests for the rules-based lead scorer.
// Every weight in scoring.ts has a test here — change a weight and
// the corresponding test must change too.

import { describe, expect, it } from "vitest";
import {
  scoreLead,
  scoreSource,
  scoreEngagement,
  scoreProfile,
  scoreStage,
  scoreBand,
} from "./scoring";

const NOW = new Date("2026-10-14T12:00:00+05:30");

function base() {
  return {
    source: "web_form",
    inboundMessageCount: 0,
    lastInboundAt: null,
    name: "Asha",
    phone: "+919810000000",
    email: "asha@example.com",
    status: "new",
  };
}

describe("scoreSource", () => {
  it("ranks warm intent highest", () => {
    expect(scoreSource("whatsapp")).toBe(25);
    expect(scoreSource("instagram")).toBe(20);
    expect(scoreSource("facebook")).toBe(18);
  });
  it("ranks colder sources lower", () => {
    expect(scoreSource("web_form")).toBe(15);
    expect(scoreSource("justdial")).toBe(12);
    expect(scoreSource("import")).toBe(8);
    expect(scoreSource("manual")).toBe(8);
  });
  it("falls back for unknown and null sources", () => {
    expect(scoreSource("carrier_pigeon")).toBe(5);
    expect(scoreSource(null)).toBe(5);
    expect(scoreSource("  WhatsApp ")).toBe(25); // case/space tolerant
  });
});

describe("scoreEngagement", () => {
  it("scores message volume in tiers", () => {
    expect(scoreEngagement(0, null, NOW)).toBe(0);
    expect(scoreEngagement(1, null, NOW)).toBe(10);
    expect(scoreEngagement(2, null, NOW)).toBe(10);
    expect(scoreEngagement(3, null, NOW)).toBe(20);
    expect(scoreEngagement(5, null, NOW)).toBe(20);
    expect(scoreEngagement(6, null, NOW)).toBe(25);
    expect(scoreEngagement(100, null, NOW)).toBe(25);
  });
  it("adds the recency bonus for fresh inbound, capped at 30", () => {
    const fresh = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(scoreEngagement(6, fresh, NOW)).toBe(30); // 25 + 5, capped
    expect(scoreEngagement(1, fresh, NOW)).toBe(15);
    const stale = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(scoreEngagement(1, stale, NOW)).toBe(10); // no bonus
  });
  it("ignores future timestamps and garbage", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(scoreEngagement(1, future, NOW)).toBe(10);
    expect(scoreEngagement(1, "not-a-date", NOW)).toBe(10);
    expect(scoreEngagement(-5, null, NOW)).toBe(0);
  });
});

describe("scoreProfile", () => {
  it("adds up present fields", () => {
    expect(scoreProfile("Asha", "+91", "a@b.c")).toBe(20);
    expect(scoreProfile("Asha", "+91", null)).toBe(14);
    expect(scoreProfile(null, null, null)).toBe(0);
    expect(scoreProfile("  ", "", null)).toBe(0); // blanks don't count
  });
});

describe("scoreStage", () => {
  it("follows the pipeline", () => {
    expect(scoreStage("new")).toBe(5);
    expect(scoreStage("contacted")).toBe(12);
    expect(scoreStage("qualified")).toBe(20);
    expect(scoreStage("converted")).toBe(25);
    expect(scoreStage("lost")).toBe(0);
    expect(scoreStage(null)).toBe(0);
    expect(scoreStage("mystery")).toBe(0);
  });
});

describe("scoreLead", () => {
  it("sums to a perfect 100 for the ideal lead", () => {
    const r = scoreLead(
      {
        ...base(),
        source: "whatsapp",
        inboundMessageCount: 8,
        lastInboundAt: new Date(NOW.getTime() - 86400_000).toISOString(),
        status: "converted",
      },
      NOW,
    );
    expect(r.score).toBe(100);
    expect(r.breakdown).toEqual({ source: 25, engagement: 30, profile: 20, stage: 25 });
  });
  it("scores a cold lead low", () => {
    const r = scoreLead(
      {
        source: "import",
        inboundMessageCount: 0,
        lastInboundAt: null,
        name: null,
        phone: "+919810000000",
        email: null,
        status: "new",
      },
      NOW,
    );
    // 8 + 0 + 7 + 5 = 20
    expect(r.score).toBe(20);
  });
  it("never exceeds 100 or drops below 0", () => {
    const r = scoreLead({ ...base(), inboundMessageCount: 1e9 }, NOW);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreBand", () => {
  it("bands hot/warm/cold", () => {
    expect(scoreBand(100)).toBe("hot");
    expect(scoreBand(70)).toBe("hot");
    expect(scoreBand(69)).toBe("warm");
    expect(scoreBand(40)).toBe("warm");
    expect(scoreBand(39)).toBe("cold");
    expect(scoreBand(0)).toBe("cold");
  });
});
