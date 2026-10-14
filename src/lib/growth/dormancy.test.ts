import { describe, expect, it } from "vitest";
import {
  isDormant,
  recentlyEngagedByWinback,
  maxInstant,
  DAY_MS,
} from "./dormancy";

const NOW = new Date("2026-10-14T12:00:00+05:30");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

describe("isDormant", () => {
  it("flags contacts inactive past the window", () => {
    expect(
      isDormant({ lastActivityAt: daysAgo(61), createdAt: daysAgo(200) }, 60, NOW),
    ).toBe(true);
  });
  it("is false on the boundary edge (just under the window)", () => {
    expect(
      isDormant({ lastActivityAt: daysAgo(59), createdAt: daysAgo(200) }, 60, NOW),
    ).toBe(false);
  });
  it("treats the exact boundary as dormant", () => {
    expect(
      isDormant({ lastActivityAt: daysAgo(60), createdAt: daysAgo(200) }, 60, NOW),
    ).toBe(true);
  });
  it("uses createdAt for never-active contacts, sparing brand-new ones", () => {
    expect(isDormant({ lastActivityAt: null, createdAt: daysAgo(90) }, 60, NOW)).toBe(
      true,
    );
    expect(isDormant({ lastActivityAt: null, createdAt: daysAgo(10) }, 60, NOW)).toBe(
      false,
    );
  });
  it("never auto-enrolls when there are no timestamps at all", () => {
    expect(isDormant({ lastActivityAt: null, createdAt: null }, 60, NOW)).toBe(false);
  });
  it("ignores future timestamps and rejects bad windows", () => {
    expect(
      isDormant(
        { lastActivityAt: new Date(NOW.getTime() + 60_000).toISOString(), createdAt: null },
        60,
        NOW,
      ),
    ).toBe(false);
    expect(() => isDormant({ lastActivityAt: daysAgo(90), createdAt: null }, -1, NOW)).toThrow();
  });
});

describe("recentlyEngagedByWinback", () => {
  it("skips contacts win-backed inside the exclusion window", () => {
    expect(recentlyEngagedByWinback(daysAgo(30), 90, NOW)).toBe(true);
    expect(recentlyEngagedByWinback(daysAgo(89), 90, NOW)).toBe(true);
  });
  it("allows re-enrollment after the window passes", () => {
    expect(recentlyEngagedByWinback(daysAgo(91), 90, NOW)).toBe(false);
    expect(recentlyEngagedByWinback(null, 90, NOW)).toBe(false);
    expect(recentlyEngagedByWinback(daysAgo(10), 0, NOW)).toBe(false);
  });
});

describe("maxInstant", () => {
  it("picks the latest instant, null when empty", () => {
    expect(maxInstant(daysAgo(5), daysAgo(1), daysAgo(10))).toBe(daysAgo(1));
    expect(maxInstant(null, null)).toBe(null);
    expect(maxInstant(null, daysAgo(3))).toBe(daysAgo(3));
  });
});
