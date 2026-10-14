// GST math unit tests — integer paise discipline, intra/inter-state
// splits, rounding, payment status transitions, and number formats.

import { describe, expect, it } from "vitest";
import {
  amountDuePaise,
  computeInvoice,
  computeLine,
  formatINR,
  isIntraState,
  parseRupeesToPaise,
  paymentStatusAfter,
  roundPaise,
  sumLines,
} from "./gst";
import { formatBillingNumber } from "./numbering";

describe("roundPaise", () => {
  it("rounds half up", () => {
    expect(roundPaise(14998.5)).toBe(14999);
    expect(roundPaise(14998.4)).toBe(14998);
    expect(roundPaise(0)).toBe(0);
  });
  it("rejects negative and non-finite input", () => {
    expect(() => roundPaise(-1)).toThrow();
    expect(() => roundPaise(NaN)).toThrow();
  });
});

describe("computeLine — intra-state (CGST+SGST)", () => {
  it("splits 18% evenly on ₹1000 (Delhi → Delhi)", () => {
    const l = computeLine(
      { description: "Service", quantity: 1, ratePaise: 100000, gstRate: 18 },
      "07",
      "07",
    );
    expect(l.taxablePaise).toBe(100000);
    expect(l.cgstPaise).toBe(9000);
    expect(l.sgstPaise).toBe(9000);
    expect(l.igstPaise).toBe(0);
    expect(l.taxPaise).toBe(18000);
    expect(l.totalPaise).toBe(118000);
  });

  it("handles fractional quantity before tax (1.5 × ₹99.99)", () => {
    const l = computeLine(
      { description: "Hours", quantity: 1.5, ratePaise: 9999, gstRate: 18 },
      "07",
      "07",
    );
    // 1.5 × 9999 = 14998.5 → 14999 paise taxable (half-up)
    expect(l.taxablePaise).toBe(14999);
    // 14999 × 18% = 2699.82 → 2700; split 1350/1350
    expect(l.cgstPaise).toBe(1350);
    expect(l.sgstPaise).toBe(1350);
    expect(l.totalPaise).toBe(14999 + 2700);
  });

  it("splits an odd 5% rate without losing a paise (₹0.10 taxable)", () => {
    const l = computeLine(
      { description: "Tiny", quantity: 1, ratePaise: 10, gstRate: 5 },
      "27",
      "27",
    );
    // 10 × 5% = 0.5 → 1 paise total tax; CGST takes half-up (1), SGST the rest (0)
    expect(l.taxPaise).toBe(1);
    expect(l.cgstPaise).toBe(1);
    expect(l.sgstPaise).toBe(0);
    expect(l.cgstPaise + l.sgstPaise).toBe(l.taxPaise);
  });

  it("5% on ₹100 splits exactly (250/250)", () => {
    const l = computeLine(
      { description: "Goods", quantity: 1, ratePaise: 10000, gstRate: 5 },
      "09",
      "09",
    );
    expect(l.cgstPaise).toBe(250);
    expect(l.sgstPaise).toBe(250);
    expect(l.totalPaise).toBe(10500);
  });
});

describe("computeLine — inter-state (IGST)", () => {
  it("charges full 18% as IGST (Delhi → Maharashtra)", () => {
    const l = computeLine(
      { description: "Service", quantity: 2, ratePaise: 50000, gstRate: 18 },
      "07",
      "27",
    );
    expect(l.taxablePaise).toBe(100000);
    expect(l.igstPaise).toBe(18000);
    expect(l.cgstPaise).toBe(0);
    expect(l.sgstPaise).toBe(0);
    expect(l.totalPaise).toBe(118000);
  });
});

describe("computeLine — exempt and edge cases", () => {
  it("0% rate produces no tax", () => {
    const l = computeLine(
      { description: "Exempt goods", quantity: 3, ratePaise: 20000, gstRate: 0 },
      "07",
      "27",
    );
    expect(l.taxPaise).toBe(0);
    expect(l.totalPaise).toBe(60000);
  });

  it("defaults to intra-state when states are unknown", () => {
    const l = computeLine(
      { description: "Service", quantity: 1, ratePaise: 100000, gstRate: 18 },
      null,
      null,
    );
    expect(l.cgstPaise).toBe(9000);
    expect(l.igstPaise).toBe(0);
  });

  it("rejects invalid inputs", () => {
    const base = { description: "x", quantity: 1, ratePaise: 100, gstRate: 18 };
    expect(() => computeLine({ ...base, quantity: 0 }, "07", "07")).toThrow();
    expect(() => computeLine({ ...base, ratePaise: 10.5 }, "07", "07")).toThrow();
    expect(() => computeLine({ ...base, ratePaise: -5 }, "07", "07")).toThrow();
    expect(() => computeLine({ ...base, gstRate: 30 }, "07", "07")).toThrow();
  });
});

describe("computeInvoice / sumLines", () => {
  it("sums rounded lines: mixed intra-state lines", () => {
    const { lines, totals } = computeInvoice(
      [
        { description: "A", quantity: 1, ratePaise: 100000, gstRate: 18 },
        { description: "B", quantity: 2, ratePaise: 25000, gstRate: 12 },
      ],
      "07",
      "07",
    );
    expect(lines).toHaveLength(2);
    expect(totals.subtotalPaise).toBe(150000);
    expect(totals.cgstPaise).toBe(9000 + 3000);
    expect(totals.sgstPaise).toBe(9000 + 3000);
    expect(totals.igstPaise).toBe(0);
    expect(totals.taxPaise).toBe(24000);
    expect(totals.totalPaise).toBe(174000);
  });

  it("sumLines agrees with computeInvoice totals", () => {
    const { lines, totals } = computeInvoice(
      [{ description: "A", quantity: 1, ratePaise: 999, gstRate: 28 }],
      "07",
      "33",
    );
    expect(sumLines(lines)).toEqual(totals);
    expect(totals.igstPaise).toBe(Math.round(999 * 0.28));
  });
});

describe("isIntraState", () => {
  it("compares state codes", () => {
    expect(isIntraState("07", "07")).toBe(true);
    expect(isIntraState("07", "27")).toBe(false);
    expect(isIntraState(null, "27")).toBe(true);
  });
});

describe("paymentStatusAfter", () => {
  it("transitions issued → partially_paid → paid", () => {
    expect(paymentStatusAfter(10000, 0)).toBe("issued");
    expect(paymentStatusAfter(10000, 4000)).toBe("partially_paid");
    expect(paymentStatusAfter(10000, 9999)).toBe("partially_paid");
    expect(paymentStatusAfter(10000, 10000)).toBe("paid");
    expect(paymentStatusAfter(10000, 15000)).toBe("paid");
  });
  it("rejects invalid money", () => {
    expect(() => paymentStatusAfter(-1, 0)).toThrow();
    expect(() => paymentStatusAfter(100, 10.5)).toThrow();
  });
});

describe("amountDuePaise", () => {
  it("never goes negative", () => {
    expect(amountDuePaise(10000, 4000)).toBe(6000);
    expect(amountDuePaise(10000, 10000)).toBe(0);
    expect(amountDuePaise(10000, 15000)).toBe(0);
  });
});

describe("formatINR", () => {
  it("uses Indian digit grouping", () => {
    expect(formatINR(12345678)).toBe("₹1,23,456.78");
    expect(formatINR(100)).toBe("₹1.00");
    expect(formatINR(100, { withSymbol: false })).toBe("1.00");
  });
});

describe("parseRupeesToPaise", () => {
  it("parses human amounts to integer paise", () => {
    expect(parseRupeesToPaise("1,234.50")).toBe(123450);
    expect(parseRupeesToPaise("₹99")).toBe(9900);
    expect(parseRupeesToPaise("100")).toBe(10000);
    expect(parseRupeesToPaise("0.05")).toBe(5);
  });
  it("rejects malformed input", () => {
    expect(parseRupeesToPaise("abc")).toBeNull();
    expect(parseRupeesToPaise("12.345")).toBeNull();
    expect(parseRupeesToPaise("")).toBeNull();
    expect(parseRupeesToPaise("-5")).toBeNull();
  });
});

describe("billing number format", () => {
  it("formats PREFIX-YYYY-NNNN with zero padding", () => {
    expect(formatBillingNumber("INV", 2026, 1)).toBe("INV-2026-0001");
    expect(formatBillingNumber("QT", 2026, 42)).toBe("QT-2026-0042");
    expect(formatBillingNumber("RCP", 2026, 12345)).toBe("RCP-2026-12345");
  });
  it("numbering.ts re-exports the same format", () => {
    expect(formatBillingNumber("INV", 2026, 7)).toBe("INV-2026-0007");
  });
});
