// Drip scheduler unit tests — due-date math, quiet hours, caps,
// opt-out detection, and inbound disposition.
//
// Asia/Kolkata is UTC+5:30 year-round (no DST), so test instants are
// written in UTC and annotated with their IST wall time.

import { describe, expect, it } from "vitest";
import {
  computeStepDue,
  inboundDisposition,
  isOptOut,
  isQuietHours,
  renderTemplate,
  selectDueEnrollments,
  shiftPastQuietHours,
  startOfDayInZone,
  withinDailyCap,
  type EnrollmentLike,
  type QuietConfig,
} from "./scheduler";

const QUIET: QuietConfig = {
  quietStart: "21:00",
  quietEnd: "09:00",
  timezone: "Asia/Kolkata",
};

const NO_QUIET: QuietConfig = {
  quietStart: "00:00",
  quietEnd: "00:00",
  timezone: "Asia/Kolkata",
};

const utc = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi));

describe("isOptOut", () => {
  it("matches STOP / UNSUBSCRIBE case-insensitively", () => {
    expect(isOptOut("STOP")).toBe(true);
    expect(isOptOut("stop")).toBe(true);
    expect(isOptOut("UnSuBsCrIbE")).toBe(true);
  });
  it("matches when embedded in a sentence", () => {
    expect(isOptOut("please STOP sending these")).toBe(true);
    expect(isOptOut("UNSUBSCRIBE me now")).toBe(true);
  });
  it("does not match near-misses or empty input", () => {
    expect(isOptOut("hello")).toBe(false);
    expect(isOptOut("stopwatch")).toBe(false); // single token, not STOP
    expect(isOptOut("")).toBe(false);
    expect(isOptOut(null)).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("substitutes {{name}} and {{business}}", () => {
    expect(
      renderTemplate("Hi {{name}}, this is {{business}}!", {
        name: "Asha",
        business: "Glow Salon",
      }),
    ).toBe("Hi Asha, this is Glow Salon!");
  });
  it("tolerates whitespace and casing in the variable", () => {
    expect(renderTemplate("Hi {{ Name }}!", { name: "Asha" })).toBe("Hi Asha!");
  });
  it("renders missing values as empty and leaves unknown vars alone", () => {
    expect(renderTemplate("Hi {{name}}!", {})).toBe("Hi !");
    expect(renderTemplate("Hi {{foo}}!", {})).toBe("Hi {{foo}}!");
  });
});

describe("isQuietHours", () => {
  it("flags the overnight window on the IST clock", () => {
    expect(isQuietHours(utc(2026, 10, 14, 16, 30), QUIET)).toBe(true); // 22:00 IST
    expect(isQuietHours(utc(2026, 10, 14, 22, 0), QUIET)).toBe(true); // 03:30 IST
  });
  it("is inclusive at the start, exclusive at the end", () => {
    expect(isQuietHours(utc(2026, 10, 14, 15, 30), QUIET)).toBe(true); // 21:00 IST
    expect(isQuietHours(utc(2026, 10, 15, 3, 30), QUIET)).toBe(false); // 09:00 IST
  });
  it("returns false outside the window", () => {
    expect(isQuietHours(utc(2026, 10, 14, 4, 30), QUIET)).toBe(false); // 10:00 IST
    expect(isQuietHours(utc(2026, 10, 14, 12, 0), QUIET)).toBe(false); // 17:30 IST
  });
  it("treats start === end as no quiet hours", () => {
    expect(isQuietHours(utc(2026, 10, 14, 16, 30), NO_QUIET)).toBe(false);
  });
  it("supports same-day windows", () => {
    const lunch: QuietConfig = {
      quietStart: "13:00",
      quietEnd: "14:00",
      timezone: "Asia/Kolkata",
    };
    expect(isQuietHours(utc(2026, 10, 14, 8, 0), lunch)).toBe(true); // 13:30 IST
    expect(isQuietHours(utc(2026, 10, 14, 9, 0), lunch)).toBe(false); // 14:30 IST
  });
});

describe("shiftPastQuietHours", () => {
  it("leaves non-quiet times untouched", () => {
    const d = utc(2026, 10, 14, 4, 30); // 10:00 IST
    expect(shiftPastQuietHours(d, QUIET).getTime()).toBe(d.getTime());
  });
  it("pushes a 22:00 IST due to 09:00 IST the next day", () => {
    const shifted = shiftPastQuietHours(utc(2026, 10, 14, 16, 30), QUIET);
    // 09:00 IST Oct 15 = 03:30 UTC Oct 15
    expect(shifted.getTime()).toBe(utc(2026, 10, 15, 3, 30).getTime());
  });
});

describe("computeStepDue", () => {
  it("adds day offsets keeping the enrollment wall time", () => {
    const enrolled = utc(2026, 10, 14, 4, 30); // 10:00 IST
    const due = computeStepDue(enrolled, 3, QUIET);
    expect(due.getTime()).toBe(utc(2026, 10, 17, 4, 30).getTime());
  });
  it("day 0 at 22:00 IST pushes to next-day 09:00 IST", () => {
    const enrolled = utc(2026, 10, 14, 16, 30); // 22:00 IST
    const due = computeStepDue(enrolled, 0, QUIET);
    expect(due.getTime()).toBe(utc(2026, 10, 15, 3, 30).getTime());
  });
  it("rejects negative or fractional offsets", () => {
    expect(() => computeStepDue(new Date(), -1, QUIET)).toThrow();
    expect(() => computeStepDue(new Date(), 1.5, QUIET)).toThrow();
  });
});

describe("selectDueEnrollments", () => {
  const e = (over: Partial<EnrollmentLike>): EnrollmentLike => ({
    status: "active",
    nextDueAt: "2026-10-14T00:00:00.000Z",
    currentStep: 0,
    ...over,
  });

  it("selects active past-due enrollments, excludes the rest", () => {
    const now = utc(2026, 10, 14, 4, 30); // 10:00 IST, not quiet
    const rows = [
      e({}), // due
      e({ status: "paused" }),
      e({ status: "completed" }),
      e({ nextDueAt: "2026-10-15T00:00:00.000Z" }), // future
      e({ nextDueAt: null }),
      e({ status: "opted_out" }),
    ];
    const { due, deferredQuiet } = selectDueEnrollments(rows, now, QUIET);
    expect(due).toHaveLength(1);
    expect(deferredQuiet).toHaveLength(0);
  });

  it("defers due enrollments that land in quiet hours", () => {
    const now = utc(2026, 10, 14, 16, 30); // 22:00 IST, quiet
    const { due, deferredQuiet } = selectDueEnrollments([e({})], now, QUIET);
    expect(due).toHaveLength(0);
    expect(deferredQuiet).toHaveLength(1);
  });
});

describe("withinDailyCap", () => {
  it("treats cap <= 0 as unlimited", () => {
    expect(withinDailyCap(9999, 0)).toBe(true);
  });
  it("allows sends below the cap, blocks at the cap", () => {
    expect(withinDailyCap(49, 50)).toBe(true);
    expect(withinDailyCap(50, 50)).toBe(false);
    expect(withinDailyCap(51, 50)).toBe(false);
  });
});

describe("startOfDayInZone", () => {
  it("returns the UTC instant of local midnight", () => {
    // Oct 14 15:00 IST → local day starts Oct 14 00:00 IST = Oct 13 18:30 UTC
    const start = startOfDayInZone(utc(2026, 10, 14, 9, 30), "Asia/Kolkata");
    expect(start.getTime()).toBe(utc(2026, 10, 13, 18, 30).getTime());
  });
});

describe("inboundDisposition", () => {
  it("returns none when there are no active enrollments", () => {
    expect(inboundDisposition("STOP", 0)).toBe("none");
    expect(inboundDisposition("hello", 0)).toBe("none");
  });
  it("opt-out wins over pause", () => {
    expect(inboundDisposition("STOP", 2)).toBe("opt_out");
    expect(inboundDisposition("hello there", 2)).toBe("pause");
  });
});
