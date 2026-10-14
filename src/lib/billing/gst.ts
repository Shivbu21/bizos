// ============================================================
// GST billing math — pure functions, integer paise everywhere.
//
// Standard Indian GST mechanics (CBIC):
//   * Intra-state supply (seller state == place of supply) → tax is
//     split equally into CGST + SGST.
//   * Inter-state supply (different states) → the whole tax is IGST.
//   * Per-item GST rates: 0 (nil/exempt), 5, 12, 18, 28 percent.
//   * Reverse charge, composition scheme, e-invoicing/IRN, and
//     GSTIN checksum validation are OUT of scope for v1 (see
//     ASSUMPTIONS below) — the fields exist on the invoice so a
//     later module can implement them.
//
// Money rule: every amount is an integer number of paise. No
// floats anywhere in this file — `quantity` is the only decimal
// input and it is multiplied into paise and rounded immediately.
//
// Rounding (documented choice): commercial half-up, applied PER
// LINE ITEM, then summed. `Math.round` is half-up for positive
// values (all amounts here are positive). Rounding per line —
// rather than on the invoice total — matches how Indian GST
// invoices are normally raised (each line's tax is a whole paise).
//
// Intra-state odd-rate split (e.g. 5% → 2.5% CGST + 2.5% SGST):
// the line's total tax is computed first, CGST takes half-up of
// it, SGST takes the remainder — so CGST + SGST always equals the
// line's tax exactly, never off by a paise.
// ============================================================

/** GST rates offered in the UI. 0 = nil-rated / exempt. */
export const GST_RATES = [0, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];

/** Standard CBIC 2-digit GST state codes (public tax data). */
export interface StateCode {
  code: string;
  name: string;
}

export const INDIAN_STATE_CODES: StateCode[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
  { code: "99", name: "Other Country" },
];

export function stateNameFor(code: string | null | undefined): string {
  if (!code) return "—";
  return INDIAN_STATE_CODES.find((s) => s.code === code)?.name ?? `Code ${code}`;
}

/** Half-up rounding for positive paise values. */
export function roundPaise(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`roundPaise expects a finite non-negative number, got ${value}`);
  }
  return Math.round(value);
}

/** True when the supply stays inside one state (CGST+SGST). */
export function isIntraState(sellerStateCode: string | null | undefined, placeOfSupply: string | null | undefined): boolean {
  if (!sellerStateCode || !placeOfSupply) return true; // default to intra-state when unknown
  return sellerStateCode === placeOfSupply;
}

export interface LineInput {
  description: string;
  quantity: number;
  /** Integer paise per unit. */
  ratePaise: number;
  /** GST percent, e.g. 18. 0 = nil/exempt. */
  gstRate: number;
}

export interface LineResult extends LineInput {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** cgst + sgst + igst — exactly one pair is non-zero. */
  taxPaise: number;
  /** taxable + tax. */
  totalPaise: number;
}

export function computeLine(
  line: LineInput,
  sellerStateCode: string | null | undefined,
  placeOfSupply: string | null | undefined,
): LineResult {
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
    throw new Error(`quantity must be a positive number, got ${line.quantity}`);
  }
  if (!Number.isInteger(line.ratePaise) || line.ratePaise < 0) {
    throw new Error(`ratePaise must be a non-negative integer, got ${line.ratePaise}`);
  }
  if (!Number.isFinite(line.gstRate) || line.gstRate < 0 || line.gstRate > 28) {
    throw new Error(`gstRate must be between 0 and 28, got ${line.gstRate}`);
  }

  const taxablePaise = roundPaise(line.quantity * line.ratePaise);
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  if (line.gstRate > 0) {
    if (isIntraState(sellerStateCode, placeOfSupply)) {
      const totalTax = roundPaise((taxablePaise * line.gstRate) / 100);
      cgstPaise = roundPaise(totalTax / 2); // half-up; SGST takes the remainder
      sgstPaise = totalTax - cgstPaise;
    } else {
      igstPaise = roundPaise((taxablePaise * line.gstRate) / 100);
    }
  }

  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  return {
    ...line,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise,
    totalPaise: taxablePaise + taxPaise,
  };
}

export interface InvoiceTotals {
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
}

/** Sum of per-line results — totals are the sum of rounded lines. */
export function sumLines(lines: LineResult[]): InvoiceTotals {
  const t: InvoiceTotals = {
    subtotalPaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    taxPaise: 0,
    totalPaise: 0,
  };
  for (const l of lines) {
    t.subtotalPaise += l.taxablePaise;
    t.cgstPaise += l.cgstPaise;
    t.sgstPaise += l.sgstPaise;
    t.igstPaise += l.igstPaise;
    t.taxPaise += l.taxPaise;
    t.totalPaise += l.totalPaise;
  }
  return t;
}

export function computeInvoice(
  lines: LineInput[],
  sellerStateCode: string | null | undefined,
  placeOfSupply: string | null | undefined,
): { lines: LineResult[]; totals: InvoiceTotals } {
  const computed = lines.map((l) => computeLine(l, sellerStateCode, placeOfSupply));
  return { lines: computed, totals: sumLines(computed) };
}

/** Invoice payment status after recording a payment. Pure — the API
 *  route persists the result. Overdue is derived at read time (see
 *  server.ts), not stored by this function. */
export type PaymentStatus = "issued" | "partially_paid" | "paid";

export function paymentStatusAfter(totalPaise: number, amountPaidPaise: number): PaymentStatus {
  if (!Number.isInteger(totalPaise) || totalPaise < 0) {
    throw new Error(`totalPaise must be a non-negative integer, got ${totalPaise}`);
  }
  if (!Number.isInteger(amountPaidPaise) || amountPaidPaise < 0) {
    throw new Error(`amountPaidPaise must be a non-negative integer, got ${amountPaidPaise}`);
  }
  if (amountPaidPaise <= 0) return "issued";
  if (amountPaidPaise >= totalPaise) return "paid";
  return "partially_paid";
}

/** Amount still owed, in paise. Never negative (overpayments are
 *  rejected at the API layer). */
export function amountDuePaise(totalPaise: number, amountPaidPaise: number): number {
  return Math.max(0, totalPaise - amountPaidPaise);
}

/** ₹1,23,456.78 — Indian digit grouping via Intl. */
export function formatINR(paise: number, opts?: { withSymbol?: boolean }): string {
  const rupees = paise / 100;
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
  return opts?.withSymbol === false ? formatted : `₹${formatted}`;
}

/** Parse a user-typed rupee amount ("1,234.50", "1234.5") into integer
 *  paise. Returns null when the input is not a valid amount. */
export function parseRupeesToPaise(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const paise = Math.round(parseFloat(cleaned) * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

// ------------------------------------------------------------
// ASSUMPTIONS (documented, not invented tax law)
// ------------------------------------------------------------
// 1. Standard GST mechanics only: CGST+SGST intra-state, IGST
//    inter-state, per-item rates 0/5/12/18/28. Composition scheme,
//    reverse-charge computation, and e-invoicing (IRN/QR) are not
//    implemented — the invoice carries reverse_charge and GSTIN
//    fields so they can be added later.
// 2. Place of supply is a single 2-digit state code per invoice.
//    Mixed-supply invoices (different place of supply per line)
//    are not supported in v1.
// 3. Rounding is half-up per line item (see header). The DB stores
//    the rounded results; nothing is recomputed from floats later.
// 4. GSTIN format/checksum is NOT validated (that needs the
//    government's API or the published checksum algorithm —
//    deliberately left to a later module).
// 5. Currency is INR throughout v1. The schema carries a currency
//    column for later multi-currency work; the math assumes paise.
