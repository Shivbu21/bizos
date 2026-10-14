// Billing — Module 2 (GST invoicing + quotations).
//
// Light-first premium styling (warm paper, one indigo accent), per the
// standing UI preference — explicit light colors so this surface always
// renders light, independent of the app's theme. Same token set as the
// Module 1 lead-sources page.
//
// Two tabs:
//   1. Quotes — list, create/edit drafts, send → accept/decline, and
//      convert an accepted quote into a draft invoice.
//   2. Invoices — list, create, issue, record (partial) payments,
//      void unpaid invoices, and print payment receipts.
//
// Money is entered in rupees in the UI and converted to integer paise
// (parseRupeesToPaise) before it ever touches the API; all GST math
// previews run through the same src/lib/billing/gst.ts the server
// uses, so what you see is what gets stored.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  FileText,
  Loader2,
  Plus,
  Receipt,
  Printer,
  Trash2,
  Pencil,
  IndianRupee,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

import {
  INDIAN_STATE_CODES,
  GST_RATES,
  computeInvoice,
  formatINR,
  parseRupeesToPaise,
  stateNameFor,
} from "@/lib/billing/gst";

// ---- Light-first design tokens (explicit, theme-independent) ----
const PAPER = "bg-[#FAF6EF]";
const INK = "text-[#1C1917]";
const MUTED = "text-[#78716C]";
const CARD = "bg-white border-[#EAE3D3] rounded-2xl shadow-[0_1px_2px_rgba(28,25,23,0.05)]";
const INPUT = "bg-white border-[#E2D9C6] text-[#1C1917] placeholder:text-[#A8A29E] focus-visible:ring-[#4F46E5]";
const BTN_PRIMARY = "bg-[#4F46E5] hover:bg-[#4338CA] text-white";
const BTN_OUTLINE = "border-[#E2D9C6] bg-white text-[#44403C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";
const BTN_GHOST = "text-[#78716C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";
const BTN_DANGER = "border-[#FECACA] bg-white text-[#B91C1C] hover:bg-[#FEF2F2]";
const ROW_DIVIDER = "border-[#F0EAD9]";

// ---- Types ----
interface LineDraft {
  description: string;
  quantity: string;
  rateRupees: string;
  gstRate: string;
}

interface Quote {
  id: string;
  number: string;
  customer_name: string;
  status: string;
  total_paise: number;
  valid_until: string | null;
  created_at: string;
}

interface QuoteDetail extends Quote {
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  notes: string | null;
}

interface QuoteItem {
  description: string;
  quantity: number;
  rate_paise: number;
  gst_rate: number;
}

interface Invoice {
  id: string;
  number: string;
  buyer_name: string;
  status: string;
  total_paise: number;
  amount_paid_paise: number;
  due_at: string | null;
  created_at: string;
}

interface InvoiceDetail extends Invoice {
  seller_name: string | null;
  seller_gstin: string | null;
  seller_state_code: string | null;
  seller_address: string | null;
  buyer_gstin: string | null;
  buyer_address: string | null;
  place_of_supply: string | null;
  subtotal_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  issued_at: string | null;
  notes: string | null;
}

interface InvoiceItem {
  description: string;
  quantity: number;
  rate_paise: number;
  gst_rate: number;
  line_taxable_paise: number;
  line_cgst_paise: number;
  line_sgst_paise: number;
  line_igst_paise: number;
  line_total_paise: number;
}

interface Payment {
  id: string;
  receipt_number: string;
  amount_paise: number;
  method: string;
  reference: string | null;
  received_at: string;
  created_at: string;
}

const QUOTE_STATUS_STYLES: Record<string, string> = {
  draft: "bg-stone-100 text-stone-600 border-stone-200",
  sent: "bg-sky-50 text-sky-700 border-sky-200",
  accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  declined: "bg-rose-50 text-rose-700 border-rose-200",
  expired: "bg-amber-50 text-amber-700 border-amber-200",
};

const INVOICE_STATUS_STYLES: Record<string, string> = {
  draft: "bg-stone-100 text-stone-600 border-stone-200",
  issued: "bg-sky-50 text-sky-700 border-sky-200",
  partially_paid: "bg-amber-50 text-amber-700 border-amber-200",
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  overdue: "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-zinc-100 text-zinc-500 border-zinc-200",
};

const PAYMENT_METHODS = [
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function emptyLine(): LineDraft {
  return { description: "", quantity: "1", rateRupees: "", gstRate: "18" };
}

/** Line-item editor shared by the quote and invoice dialogs. Shows a
 *  live GST preview computed with the same math the server uses. */
function ItemEditor({
  lines,
  setLines,
  sellerState,
  placeOfSupply,
}: {
  lines: LineDraft[];
  setLines: (l: LineDraft[]) => void;
  sellerState: string;
  placeOfSupply: string;
}) {
  const preview = useMemo(() => {
    try {
      const inputs = lines
        .filter((l) => l.description.trim() && l.rateRupees.trim())
        .map((l) => ({
          description: l.description.trim(),
          quantity: Math.max(0.01, Number(l.quantity) || 1),
          ratePaise: parseRupeesToPaise(l.rateRupees) ?? 0,
          gstRate: Number(l.gstRate) || 0,
        }));
      return computeInvoice(inputs, sellerState || null, placeOfSupply || null).totals;
    } catch {
      return null;
    }
  }, [lines, sellerState, placeOfSupply]);

  const update = (idx: number, patch: Partial<LineDraft>) =>
    setLines(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className={INK}>Line items</Label>
        <Button type="button" size="sm" className={BTN_OUTLINE} onClick={() => setLines([...lines, emptyLine()])}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add item
        </Button>
      </div>
      {lines.map((line, idx) => (
        <div key={idx} className={`grid grid-cols-12 gap-2 rounded-xl border border-[#F0EAD9] bg-[#FDFBF7] p-3`}>
          <div className="col-span-12 sm:col-span-5">
            <Input
              className={INPUT}
              placeholder="Description"
              value={line.description}
              onChange={(e) => update(idx, { description: e.target.value })}
            />
          </div>
          <div className="col-span-4 sm:col-span-2">
            <Input
              className={INPUT}
              placeholder="Qty"
              inputMode="decimal"
              value={line.quantity}
              onChange={(e) => update(idx, { quantity: e.target.value })}
            />
          </div>
          <div className="col-span-4 sm:col-span-2">
            <Input
              className={INPUT}
              placeholder="₹ rate"
              inputMode="decimal"
              value={line.rateRupees}
              onChange={(e) => update(idx, { rateRupees: e.target.value })}
            />
          </div>
          <div className="col-span-3 sm:col-span-2">
            <Select value={line.gstRate} onValueChange={(v) => update(idx, { gstRate: v ?? "18" })}>
              <SelectTrigger className={INPUT}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GST_RATES.map((r) => (
                  <SelectItem key={r} value={String(r)}>
                    {r}% GST
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-1 flex items-center justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={BTN_GHOST}
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, i) => i !== idx))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      {preview && (
        <div className={`rounded-xl bg-[#F5F1E8] px-4 py-3 text-sm ${INK}`}>
          <div className="flex justify-between">
            <span className={MUTED}>Subtotal</span>
            <span>{formatINR(preview.subtotalPaise)}</span>
          </div>
          <div className="flex justify-between">
            <span className={MUTED}>Tax (CGST {formatINR(preview.cgstPaise)} + SGST {formatINR(preview.sgstPaise)} + IGST {formatINR(preview.igstPaise)})</span>
            <span>{formatINR(preview.taxPaise)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-[#E2D9C6] pt-2 font-semibold">
            <span>Total</span>
            <span>{formatINR(preview.totalPaise)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function linesToPayload(lines: LineDraft[]) {
  return lines
    .filter((l) => l.description.trim() && l.rateRupees.trim())
    .map((l) => {
      const paise = parseRupeesToPaise(l.rateRupees);
      if (paise === null) throw new Error(`Invalid rate: "${l.rateRupees}"`);
      return {
        description: l.description.trim(),
        quantity: Math.max(0.01, Number(l.quantity) || 1),
        rate_paise: paise,
        gst_rate: Number(l.gstRate) || 0,
      };
    });
}

export default function BillingPage() {
  const canWrite = useCan("send-messages"); // agent+
  const canAdmin = useCan("edit-settings"); // admin+
  const [tab, setTab] = useState("quotes");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // Quote dialog
  const [quoteDialogOpen, setQuoteDialogOpen] = useState(false);
  const [editingQuote, setEditingQuote] = useState<(QuoteDetail & { items: QuoteItem[] }) | null>(null);
  const [qCustomer, setQCustomer] = useState({ name: "", email: "", phone: "", address: "" });
  const [qValidUntil, setQValidUntil] = useState("");
  const [qNotes, setQNotes] = useState("");
  const [qLines, setQLines] = useState<LineDraft[]>([emptyLine()]);

  // Invoice dialog
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [bBuyer, setBBuyer] = useState({ name: "", gstin: "", address: "" });
  const [bSellerState, setBSellerState] = useState("");
  const [bPlaceOfSupply, setBPlaceOfSupply] = useState("");
  const [bDueAt, setBDueAt] = useState("");
  const [bNotes, setBNotes] = useState("");
  const [bLines, setBLines] = useState<LineDraft[]>([emptyLine()]);

  // Invoice detail
  const [detail, setDetail] = useState<(InvoiceDetail & { items: InvoiceItem[]; payments: Payment[] }) | null>(null);

  // Payment dialog
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("upi");
  const [payRef, setPayRef] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));

  // Receipt view
  const [receipt, setReceipt] = useState<(Payment & { invoice_number: string; buyer_name: string }) | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [q, inv] = await Promise.all([api("/api/billing/quotes"), api("/api/billing/invoices")]);
      setQuotes(q.quotes);
      setInvoices(inv.invoices);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load billing data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await api(`/api/billing/invoices/${id}`);
      setDetail({ ...d.invoice, items: d.items, payments: d.payments });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load invoice");
    }
  }, []);

  // ---- Quote actions ----
  function openNewQuote() {
    setEditingQuote(null);
    setQCustomer({ name: "", email: "", phone: "", address: "" });
    setQValidUntil("");
    setQNotes("");
    setQLines([emptyLine()]);
    setQuoteDialogOpen(true);
  }

  async function openEditQuote(id: string) {
    try {
      const d = await api(`/api/billing/quotes/${id}`);
      setEditingQuote({ ...d.quote, items: d.items });
      setQCustomer({
        name: d.quote.customer_name ?? "",
        email: d.quote.customer_email ?? "",
        phone: d.quote.customer_phone ?? "",
        address: d.quote.customer_address ?? "",
      });
      setQValidUntil(d.quote.valid_until ?? "");
      setQNotes(d.quote.notes ?? "");
      setQLines(
        d.items.length
          ? d.items.map((i: QuoteItem) => ({
              description: i.description,
              quantity: String(i.quantity),
              rateRupees: (i.rate_paise / 100).toFixed(2),
              gstRate: String(i.gst_rate),
            }))
          : [emptyLine()],
      );
      setQuoteDialogOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load quote");
    }
  }

  async function saveQuote() {
    let items;
    try {
      items = linesToPayload(qLines);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Invalid items");
      return;
    }
    if (items.length === 0) {
      toast.error("Add at least one line item");
      return;
    }
    if (!qCustomer.name.trim()) {
      toast.error("Customer name is required");
      return;
    }
    setBusy("save-quote");
    try {
      const payload = {
        customer_name: qCustomer.name.trim(),
        customer_email: qCustomer.email.trim() || null,
        customer_phone: qCustomer.phone.trim() || null,
        customer_address: qCustomer.address.trim() || null,
        valid_until: qValidUntil || null,
        notes: qNotes.trim() || null,
        items,
      };
      if (editingQuote) {
        await api(`/api/billing/quotes/${editingQuote.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast.success("Quote updated");
      } else {
        const d = await api("/api/billing/quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast.success(`Quote ${d.quote.number} created`);
      }
      setQuoteDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function quoteAction(id: string, action: "send" | "accept" | "decline" | "convert") {
    setBusy(`${action}-${id}`);
    try {
      const d = await api(`/api/billing/quotes/${id}/${action}`, { method: "POST" });
      if (action === "convert") {
        toast.success(`Invoice ${d.invoice.number} created`);
        setTab("invoices");
      } else {
        toast.success(`Quote ${action === "send" ? "sent" : action === "accept" ? "accepted" : "declined"}`);
      }
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function deleteQuote(id: string) {
    if (!confirm("Delete this draft quote? The number will not be reused.")) return;
    try {
      await api(`/api/billing/quotes/${id}`, { method: "DELETE" });
      toast.success("Quote deleted");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  // ---- Invoice actions ----
  function openNewInvoice() {
    setBBuyer({ name: "", gstin: "", address: "" });
    setBSellerState("");
    setBPlaceOfSupply("");
    setBDueAt("");
    setBNotes("");
    setBLines([emptyLine()]);
    setInvoiceDialogOpen(true);
  }

  async function saveInvoice() {
    let items;
    try {
      items = linesToPayload(bLines);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Invalid items");
      return;
    }
    if (items.length === 0) {
      toast.error("Add at least one line item");
      return;
    }
    if (!bBuyer.name.trim()) {
      toast.error("Buyer name is required");
      return;
    }
    setBusy("save-invoice");
    try {
      const d = await api("/api/billing/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyer_name: bBuyer.name.trim(),
          buyer_gstin: bBuyer.gstin.trim() || null,
          buyer_address: bBuyer.address.trim() || null,
          seller_state_code: bSellerState || null,
          place_of_supply: bPlaceOfSupply || null,
          due_at: bDueAt || null,
          notes: bNotes.trim() || null,
          items,
        }),
      });
      toast.success(`Invoice ${d.invoice.number} created as draft`);
      setInvoiceDialogOpen(false);
      load();
      refreshDetail(d.invoice.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function issueInvoice(id: string) {
    setBusy(`issue-${id}`);
    try {
      await api(`/api/billing/invoices/${id}/issue`, { method: "POST" });
      toast.success("Invoice issued");
      load();
      refreshDetail(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Issue failed");
    } finally {
      setBusy(null);
    }
  }

  async function voidInvoice(id: string) {
    if (!confirm("Void this invoice? Only unpaid invoices can be voided.")) return;
    try {
      await api(`/api/billing/invoices/${id}/void`, { method: "POST" });
      toast.success("Invoice voided");
      setDetail(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Void failed");
    }
  }

  async function recordPayment() {
    if (!detail) return;
    const paise = parseRupeesToPaise(payAmount);
    if (paise === null || paise <= 0) {
      toast.error("Enter a valid amount in rupees");
      return;
    }
    setBusy("pay");
    try {
      const d = await api(`/api/billing/invoices/${detail.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_paise: paise,
          method: payMethod,
          reference: payRef.trim() || null,
          received_at: payDate,
        }),
      });
      toast.success(`Payment recorded — receipt ${d.payment.receipt_number}`);
      setPayOpen(false);
      setPayAmount("");
      setPayRef("");
      load();
      refreshDetail(detail.id);
      setReceipt({ ...d.payment, invoice_number: detail.number, buyer_name: detail.buyer_name });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(null);
    }
  }

  const amountDue = detail ? detail.total_paise - detail.amount_paid_paise : 0;

  return (
    <div className={`${PAPER} -m-4 min-h-screen p-4 sm:-m-6 sm:p-6`}>
      {/* Print stylesheet for the receipt: only the receipt prints. */}
      <style>{`@media print { body * { visibility: hidden; } #receipt-print, #receipt-print * { visibility: visible; } #receipt-print { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>

      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className={`text-2xl font-semibold tracking-tight ${INK}`}>Billing</h1>
            <p className={`mt-1 text-sm ${MUTED}`}>
              Quotations and GST invoices — all amounts in rupees, stored as integer paise.
            </p>
          </div>
          <div className="flex gap-2">
            {tab === "quotes" ? (
              <Button className={BTN_PRIMARY} disabled={!canWrite} onClick={openNewQuote}>
                <Plus className="mr-1.5 h-4 w-4" /> New quote
              </Button>
            ) : (
              <Button className={BTN_PRIMARY} disabled={!canWrite} onClick={openNewInvoice}>
                <Plus className="mr-1.5 h-4 w-4" /> New invoice
              </Button>
            )}
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-white border border-[#EAE3D3]">
            <TabsTrigger value="quotes" className="data-[state=active]:bg-[#4F46E5] data-[state=active]:text-white">
              <FileText className="mr-1.5 h-4 w-4" /> Quotes
            </TabsTrigger>
            <TabsTrigger value="invoices" className="data-[state=active]:bg-[#4F46E5] data-[state=active]:text-white">
              <IndianRupee className="mr-1.5 h-4 w-4" /> Invoices
            </TabsTrigger>
          </TabsList>

          <TabsContent value="quotes" className="mt-4">
            <Card className={CARD}>
              <CardContent className="p-0">
                {loading ? (
                  <div className="flex items-center justify-center p-12">
                    <Loader2 className="h-6 w-6 animate-spin text-[#4F46E5]" />
                  </div>
                ) : quotes.length === 0 ? (
                  <div className={`p-12 text-center text-sm ${MUTED}`}>
                    No quotes yet. Create one to send a priced proposal to a lead.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className={ROW_DIVIDER}>
                        <TableHead className={MUTED}>Number</TableHead>
                        <TableHead className={MUTED}>Customer</TableHead>
                        <TableHead className={MUTED}>Status</TableHead>
                        <TableHead className={`${MUTED} text-right`}>Total</TableHead>
                        <TableHead className={MUTED}>Valid until</TableHead>
                        <TableHead className={`${MUTED} text-right`}>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {quotes.map((q) => (
                        <TableRow key={q.id} className={ROW_DIVIDER}>
                          <TableCell className={`font-mono text-sm font-medium ${INK}`}>{q.number}</TableCell>
                          <TableCell className={INK}>{q.customer_name}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={QUOTE_STATUS_STYLES[q.status] ?? ""}>
                              {q.status}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-medium ${INK}`}>{formatINR(q.total_paise)}</TableCell>
                          <TableCell className={`text-sm ${MUTED}`}>{q.valid_until ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              {q.status === "draft" && canWrite && (
                                <>
                                  <Button size="sm" variant="ghost" className={BTN_GHOST} onClick={() => openEditQuote(q.id)}>
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    className={BTN_OUTLINE}
                                    disabled={busy === `send-${q.id}`}
                                    onClick={() => quoteAction(q.id, "send")}
                                  >
                                    Send
                                  </Button>
                                  {canAdmin && (
                                    <Button size="sm" variant="ghost" className={BTN_GHOST} onClick={() => deleteQuote(q.id)}>
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                </>
                              )}
                              {q.status === "sent" && canWrite && (
                                <>
                                  <Button
                                    size="sm"
                                    className={BTN_OUTLINE}
                                    disabled={busy === `accept-${q.id}`}
                                    onClick={() => quoteAction(q.id, "accept")}
                                  >
                                    Accept
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className={BTN_GHOST}
                                    disabled={busy === `decline-${q.id}`}
                                    onClick={() => quoteAction(q.id, "decline")}
                                  >
                                    Decline
                                  </Button>
                                </>
                              )}
                              {q.status === "accepted" && canWrite && (
                                <Button
                                  size="sm"
                                  className={BTN_PRIMARY}
                                  disabled={busy === `convert-${q.id}`}
                                  onClick={() => quoteAction(q.id, "convert")}
                                >
                                  Convert to invoice
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="invoices" className="mt-4">
            <Card className={CARD}>
              <CardContent className="p-0">
                {loading ? (
                  <div className="flex items-center justify-center p-12">
                    <Loader2 className="h-6 w-6 animate-spin text-[#4F46E5]" />
                  </div>
                ) : invoices.length === 0 ? (
                  <div className={`p-12 text-center text-sm ${MUTED}`}>
                    No invoices yet. Create one directly, or convert an accepted quote.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className={ROW_DIVIDER}>
                        <TableHead className={MUTED}>Number</TableHead>
                        <TableHead className={MUTED}>Buyer</TableHead>
                        <TableHead className={MUTED}>Status</TableHead>
                        <TableHead className={`${MUTED} text-right`}>Total</TableHead>
                        <TableHead className={`${MUTED} text-right`}>Paid</TableHead>
                        <TableHead className={MUTED}>Due</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoices.map((inv) => (
                        <TableRow
                          key={inv.id}
                          className={`${ROW_DIVIDER} cursor-pointer hover:bg-[#FDFBF7]`}
                          onClick={() => refreshDetail(inv.id)}
                        >
                          <TableCell className={`font-mono text-sm font-medium ${INK}`}>{inv.number}</TableCell>
                          <TableCell className={INK}>{inv.buyer_name}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={INVOICE_STATUS_STYLES[inv.status] ?? ""}>
                              {inv.status.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-medium ${INK}`}>{formatINR(inv.total_paise)}</TableCell>
                          <TableCell className={`text-right ${MUTED}`}>{formatINR(inv.amount_paid_paise)}</TableCell>
                          <TableCell className={`text-sm ${MUTED}`}>{inv.due_at ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* ---- Quote create/edit dialog ---- */}
      <Dialog open={quoteDialogOpen} onOpenChange={setQuoteDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto bg-white sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className={INK}>{editingQuote ? `Edit ${editingQuote.number}` : "New quote"}</DialogTitle>
            <DialogDescription className={MUTED}>
              {editingQuote ? "Draft quotes can be edited freely." : "A sequential quote number is assigned on creation."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className={INK}>Customer name *</Label>
                <Input className={INPUT} value={qCustomer.name} onChange={(e) => setQCustomer({ ...qCustomer, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Phone</Label>
                <Input className={INPUT} value={qCustomer.phone} onChange={(e) => setQCustomer({ ...qCustomer, phone: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Email</Label>
                <Input className={INPUT} value={qCustomer.email} onChange={(e) => setQCustomer({ ...qCustomer, email: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Valid until</Label>
                <Input type="date" className={INPUT} value={qValidUntil} onChange={(e) => setQValidUntil(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className={INK}>Address</Label>
              <Textarea className={INPUT} rows={2} value={qCustomer.address} onChange={(e) => setQCustomer({ ...qCustomer, address: e.target.value })} />
            </div>
            <ItemEditor lines={qLines} setLines={setQLines} sellerState="" placeOfSupply="" />
            <div className="space-y-1.5">
              <Label className={INK}>Notes</Label>
              <Textarea className={INPUT} rows={2} value={qNotes} onChange={(e) => setQNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className={BTN_GHOST} onClick={() => setQuoteDialogOpen(false)}>Cancel</Button>
            <Button className={BTN_PRIMARY} disabled={busy === "save-quote"} onClick={saveQuote}>
              {busy === "save-quote" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {editingQuote ? "Save changes" : "Create quote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Invoice create dialog ---- */}
      <Dialog open={invoiceDialogOpen} onOpenChange={setInvoiceDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto bg-white sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className={INK}>New invoice</DialogTitle>
            <DialogDescription className={MUTED}>
              Created as a draft. GST splits by seller state vs place of supply — same state: CGST+SGST, different: IGST.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className={INK}>Buyer name *</Label>
                <Input className={INPUT} value={bBuyer.name} onChange={(e) => setBBuyer({ ...bBuyer, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Buyer GSTIN</Label>
                <Input className={INPUT} placeholder="22AAAAA0000A1Z5" value={bBuyer.gstin} onChange={(e) => setBBuyer({ ...bBuyer, gstin: e.target.value.toUpperCase() })} />
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Seller state</Label>
                <Select value={bSellerState} onValueChange={(v) => setBSellerState(v ?? "")}>
                  <SelectTrigger className={INPUT}><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {INDIAN_STATE_CODES.map((s) => (
                      <SelectItem key={s.code} value={s.code}>{s.code} — {s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Place of supply</Label>
                <Select value={bPlaceOfSupply} onValueChange={(v) => setBPlaceOfSupply(v ?? "")}>
                  <SelectTrigger className={INPUT}><SelectValue placeholder="Same as seller" /></SelectTrigger>
                  <SelectContent>
                    {INDIAN_STATE_CODES.map((s) => (
                      <SelectItem key={s.code} value={s.code}>{s.code} — {s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Due date</Label>
                <Input type="date" className={INPUT} value={bDueAt} onChange={(e) => setBDueAt(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className={INK}>Buyer address</Label>
              <Textarea className={INPUT} rows={2} value={bBuyer.address} onChange={(e) => setBBuyer({ ...bBuyer, address: e.target.value })} />
            </div>
            <ItemEditor lines={bLines} setLines={setBLines} sellerState={bSellerState} placeOfSupply={bPlaceOfSupply || bSellerState} />
            <div className="space-y-1.5">
              <Label className={INK}>Notes</Label>
              <Textarea className={INPUT} rows={2} value={bNotes} onChange={(e) => setBNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className={BTN_GHOST} onClick={() => setInvoiceDialogOpen(false)}>Cancel</Button>
            <Button className={BTN_PRIMARY} disabled={busy === "save-invoice"} onClick={saveInvoice}>
              {busy === "save-invoice" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Create draft invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Invoice detail dialog ---- */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto bg-white sm:max-w-3xl">
          {detail && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between">
                  <DialogTitle className={`font-mono ${INK}`}>{detail.number}</DialogTitle>
                  <Badge variant="outline" className={INVOICE_STATUS_STYLES[detail.status] ?? ""}>
                    {detail.status.replace("_", " ")}
                  </Badge>
                </div>
                <DialogDescription className={MUTED}>
                  {detail.buyer_name} · issued {detail.issued_at ? new Date(detail.issued_at).toLocaleDateString("en-IN") : "—"} · due {detail.due_at ?? "—"}
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className={`rounded-xl border border-[#F0EAD9] bg-[#FDFBF7] p-4 text-sm`}>
                  <p className={`font-medium ${INK}`}>Seller</p>
                  <p className={INK}>{detail.seller_name ?? "—"}</p>
                  <p className={MUTED}>{detail.seller_gstin ? `GSTIN ${detail.seller_gstin}` : "GSTIN not set"}</p>
                  <p className={MUTED}>{detail.seller_address}</p>
                  <p className={MUTED}>{stateNameFor(detail.seller_state_code)}</p>
                </div>
                <div className={`rounded-xl border border-[#F0EAD9] bg-[#FDFBF7] p-4 text-sm`}>
                  <p className={`font-medium ${INK}`}>Buyer</p>
                  <p className={INK}>{detail.buyer_name}</p>
                  <p className={MUTED}>{detail.buyer_gstin ? `GSTIN ${detail.buyer_gstin}` : "GSTIN not set"}</p>
                  <p className={MUTED}>{detail.buyer_address}</p>
                  <p className={MUTED}>Place of supply: {stateNameFor(detail.place_of_supply)}</p>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow className={ROW_DIVIDER}>
                    <TableHead className={MUTED}>Item</TableHead>
                    <TableHead className={`${MUTED} text-right`}>Qty</TableHead>
                    <TableHead className={`${MUTED} text-right`}>Rate</TableHead>
                    <TableHead className={`${MUTED} text-right`}>GST</TableHead>
                    <TableHead className={`${MUTED} text-right`}>Tax</TableHead>
                    <TableHead className={`${MUTED} text-right`}>Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map((it, i) => (
                    <TableRow key={i} className={ROW_DIVIDER}>
                      <TableCell className={INK}>{it.description}</TableCell>
                      <TableCell className={`text-right ${MUTED}`}>{it.quantity}</TableCell>
                      <TableCell className={`text-right ${MUTED}`}>{formatINR(it.rate_paise)}</TableCell>
                      <TableCell className={`text-right ${MUTED}`}>{it.gst_rate}%</TableCell>
                      <TableCell className={`text-right ${MUTED}`}>
                        {formatINR(it.line_cgst_paise + it.line_sgst_paise + it.line_igst_paise)}
                      </TableCell>
                      <TableCell className={`text-right font-medium ${INK}`}>{formatINR(it.line_total_paise)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className={`space-y-1.5 rounded-xl bg-[#F5F1E8] px-4 py-3 text-sm ${INK}`}>
                <div className="flex justify-between"><span className={MUTED}>Subtotal</span><span>{formatINR(detail.subtotal_paise)}</span></div>
                {detail.cgst_paise > 0 && <div className="flex justify-between"><span className={MUTED}>CGST</span><span>{formatINR(detail.cgst_paise)}</span></div>}
                {detail.sgst_paise > 0 && <div className="flex justify-between"><span className={MUTED}>SGST</span><span>{formatINR(detail.sgst_paise)}</span></div>}
                {detail.igst_paise > 0 && <div className="flex justify-between"><span className={MUTED}>IGST</span><span>{formatINR(detail.igst_paise)}</span></div>}
                <div className="flex justify-between border-t border-[#E2D9C6] pt-2 font-semibold">
                  <span>Total</span><span>{formatINR(detail.total_paise)}</span>
                </div>
                <div className="flex justify-between"><span className={MUTED}>Paid</span><span className="text-emerald-700">{formatINR(detail.amount_paid_paise)}</span></div>
                <div className="flex justify-between font-semibold">
                  <span>Amount due</span><span className={amountDue > 0 ? "text-red-700" : INK}>{formatINR(amountDue)}</span>
                </div>
              </div>

              {detail.payments.length > 0 && (
                <div>
                  <p className={`mb-2 text-sm font-medium ${INK}`}>Payments</p>
                  <Table>
                    <TableHeader>
                      <TableRow className={ROW_DIVIDER}>
                        <TableHead className={MUTED}>Receipt</TableHead>
                        <TableHead className={MUTED}>Date</TableHead>
                        <TableHead className={MUTED}>Method</TableHead>
                        <TableHead className={`${MUTED} text-right`}>Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.payments.map((p) => (
                        <TableRow key={p.id} className={ROW_DIVIDER}>
                          <TableCell className={`font-mono text-sm ${INK}`}>{p.receipt_number}</TableCell>
                          <TableCell className={`text-sm ${MUTED}`}>{p.received_at}</TableCell>
                          <TableCell className={`text-sm ${MUTED}`}>{p.method.replace("_", " ")}{p.reference ? ` · ${p.reference}` : ""}</TableCell>
                          <TableCell className={`text-right font-medium ${INK}`}>{formatINR(p.amount_paise)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <DialogFooter className="flex-wrap gap-2">
                {detail.status === "draft" && canWrite && (
                  <Button className={BTN_PRIMARY} disabled={busy === `issue-${detail.id}`} onClick={() => issueInvoice(detail.id)}>
                    {busy === `issue-${detail.id}` && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    Issue invoice
                  </Button>
                )}
                {["issued", "partially_paid", "overdue"].includes(detail.status) && canWrite && (
                  <Button className={BTN_OUTLINE} onClick={() => { setPayAmount(""); setPayOpen(true); }}>
                    <Receipt className="mr-1.5 h-4 w-4" /> Record payment
                  </Button>
                )}
                {["issued", "partially_paid", "overdue"].includes(detail.status) && canAdmin && detail.amount_paid_paise === 0 && (
                  <Button className={BTN_DANGER} onClick={() => voidInvoice(detail.id)}>
                    Void invoice
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Record payment dialog ---- */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="bg-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle className={INK}>Record payment</DialogTitle>
            <DialogDescription className={MUTED}>
              {detail && <>Amount due on {detail.number}: <span className={`font-semibold ${INK}`}>{formatINR(amountDue)}</span></>}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className={INK}>Amount (₹) *</Label>
              <Input className={INPUT} inputMode="decimal" placeholder="e.g. 5,900.00" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className={INK}>Method</Label>
                <Select value={payMethod} onValueChange={(v) => setPayMethod(v ?? "upi")}>
                  <SelectTrigger className={INPUT}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className={INK}>Received on</Label>
                <Input type="date" className={INPUT} value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className={INK}>Reference (UTR / txn id)</Label>
              <Input className={INPUT} value={payRef} onChange={(e) => setPayRef(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className={BTN_GHOST} onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button className={BTN_PRIMARY} disabled={busy === "pay"} onClick={recordPayment}>
              {busy === "pay" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Record payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Receipt view (printable) ---- */}
      <Dialog open={!!receipt} onOpenChange={(open) => !open && setReceipt(null)}>
        <DialogContent className="bg-white sm:max-w-md">
          {receipt && (
            <div id="receipt-print" className="bg-white p-2">
              <div className="border-2 border-[#1C1917] p-6">
                <p className={`text-center text-lg font-bold tracking-wide ${INK}`}>PAYMENT RECEIPT</p>
                <Separator className="my-4 bg-[#1C1917]" />
                <div className={`space-y-2 text-sm ${INK}`}>
                  <div className="flex justify-between"><span className={MUTED}>Receipt no.</span><span className="font-mono font-semibold">{receipt.receipt_number}</span></div>
                  <div className="flex justify-between"><span className={MUTED}>Invoice</span><span className="font-mono">{receipt.invoice_number}</span></div>
                  <div className="flex justify-between"><span className={MUTED}>Received from</span><span>{receipt.buyer_name}</span></div>
                  <div className="flex justify-between"><span className={MUTED}>Date</span><span>{receipt.received_at}</span></div>
                  <div className="flex justify-between"><span className={MUTED}>Method</span><span>{receipt.method.replace("_", " ")}{receipt.reference ? ` · ${receipt.reference}` : ""}</span></div>
                  <Separator className="my-2 bg-[#E2D9C6]" />
                  <div className="flex justify-between text-base font-bold">
                    <span>Amount received</span><span>{formatINR(receipt.amount_paise)}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2 print:hidden">
                <Button className={BTN_OUTLINE} onClick={() => window.print()}>
                  <Printer className="mr-1.5 h-4 w-4" /> Print
                </Button>
                <Button className={BTN_PRIMARY} onClick={() => setReceipt(null)}>Done</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
