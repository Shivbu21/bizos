// Growth — admin page for Module 5 (continuous upsell loop).
//
// Light-first premium styling (warm paper, one indigo accent), per
// the standing UI preference. Explicit light colors throughout so
// this surface always renders light, independent of the app's theme.
//
// Four views (tabs):
//   1. Lead scores — rules-based leaderboard with badges, sort +
//      min-score/status filters, one-click backfill.
//   2. Win-back — dormancy settings (days, sequence, exclusion
//      window); dormant contacts auto-enroll via the Module 3 engine.
//   3. Reviews — post-invoice review-request settings + due queue.
//   4. Referrals — code generator + referral log.

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  BadgePercent,
  Gift,
  Loader2,
  MessageSquareHeart,
  RefreshCw,
  Star,
  TrendingUp,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ---- Light-first design tokens (explicit, theme-independent) ----
const PAPER = "bg-[#FAF6EF]";
const INK = "text-[#1C1917]";
const MUTED = "text-[#78716C]";
const CARD =
  "bg-white border-[#EAE3D3] rounded-2xl shadow-[0_1px_2px_rgba(28,25,23,0.05)]";
const INPUT =
  "bg-white border-[#E2D9C6] text-[#1C1917] placeholder:text-[#A8A29E] focus-visible:ring-[#4F46E5]";
const BTN_PRIMARY = "bg-[#4F46E5] hover:bg-[#4338CA] text-white";
const BTN_OUTLINE =
  "border-[#E2D9C6] bg-white text-[#44403C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";
const TABS = "bg-[#F1EAD9] rounded-xl p-1";
const TAB_TRIGGER =
  "rounded-lg px-4 py-2 text-sm font-medium text-[#78716C] data-[state=active]:bg-white data-[state=active]:text-[#1C1917] data-[state=active]:shadow-sm";

const SCORE_BADGE: Record<string, string> = {
  hot: "bg-[#FEE2E2] text-[#DC2626] border-[#FECACA]",
  warm: "bg-[#FEF3C7] text-[#B45309] border-[#FDE68A]",
  cold: "bg-[#F5F5F4] text-[#78716C] border-[#E7E5E4]",
};

const REVIEW_STATUS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  sent: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200",
};

function band(score: number): "hot" | "warm" | "cold" {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------------- Scores tab ----------------

interface ScoreRow {
  lead_id: string;
  score: number;
  breakdown: { source: number; engagement: number; profile: number; stage: number };
  computed_at: string;
  leads: { id: string; name: string | null; phone: string | null; status: string | null; source: string | null };
}

function ScoresTab() {
  const canEdit = useCan("edit-settings");
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [sort, setSort] = useState("score_desc");
  const [minScore, setMinScore] = useState("0");
  const [status, setStatus] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, min_score: minScore || "0", limit: "100" });
      if (status !== "all") params.set("status", status);
      const body = await api(`/api/growth/scores?${params.toString()}`);
      setRows(body.scores ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load scores");
    } finally {
      setLoading(false);
    }
  }, [sort, minScore, status]);

  useEffect(() => {
    load();
  }, [load]);

  const backfill = async () => {
    setBackfilling(true);
    try {
      const body = await api("/api/growth/scores/backfill", { method: "POST" });
      toast.success(`Scored ${body.ok} of ${body.total} leads`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <Card className={CARD}>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className={`${INK} text-base`}>Lead scores</CardTitle>
          <p className={`${MUTED} text-sm mt-1`}>
            Rules-based, fully transparent — every weight is documented in MODULE5.md. No
            black box.
          </p>
        </div>
        <Button
          className={BTN_OUTLINE}
          size="sm"
          onClick={backfill}
          disabled={!canEdit || backfilling}
          title={canEdit ? "Recompute all scores" : "Read-only"}
        >
          {backfilling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="ml-2">Recompute all</span>
        </Button>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Label className={MUTED}>Sort</Label>
            <Select value={sort} onValueChange={(v) => setSort(v ?? "score_desc")}>
              <SelectTrigger className={`${INPUT} w-36`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="score_desc">Highest first</SelectItem>
                <SelectItem value="score_asc">Lowest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label className={MUTED}>Min score</Label>
            <Input
              className={`${INPUT} w-20`}
              type="number"
              min={0}
              max={100}
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label className={MUTED}>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v ?? "all")}>
              <SelectTrigger className={`${INPUT} w-36`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
                <SelectItem value="qualified">Qualified</SelectItem>
                <SelectItem value="converted">Converted</SelectItem>
                <SelectItem value="lost">Lost</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {loading ? (
          <div className={`flex items-center gap-2 ${MUTED} py-8 justify-center`}>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading scores…
          </div>
        ) : rows.length === 0 ? (
          <p className={`${MUTED} py-8 text-center text-sm`}>
            No scores yet. Capture a lead or run “Recompute all”.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={MUTED}>Lead</TableHead>
                <TableHead className={MUTED}>Score</TableHead>
                <TableHead className={MUTED}>Breakdown (source / engage / profile / stage)</TableHead>
                <TableHead className={MUTED}>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const b = band(r.score);
                const bd = r.breakdown ?? { source: 0, engagement: 0, profile: 0, stage: 0 };
                return (
                  <TableRow key={r.lead_id}>
                    <TableCell>
                      <div className={`${INK} font-medium`}>{r.leads.name || "—"}</div>
                      <div className={`${MUTED} text-xs`}>{r.leads.phone || ""}</div>
                    </TableCell>
                    <TableCell>
                      <Badge className={`${SCORE_BADGE[b]} border font-semibold`}>
                        {r.score} · {b}
                      </Badge>
                    </TableCell>
                    <TableCell className={`${MUTED} text-xs font-mono`}>
                      S{bd.source} · E{bd.engagement} · P{bd.profile} · Q{bd.stage}
                    </TableCell>
                    <TableCell className={`${MUTED} text-sm`}>{r.leads.status}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------- Win-back tab ----------------

interface WinbackSeq {
  id: string;
  name: string;
  kind: string | null;
  active: boolean;
}

function WinbackTab() {
  const canEdit = useCan("edit-settings");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seqs, setSeqs] = useState<WinbackSeq[]>([]);
  const [form, setForm] = useState({
    winback_enabled: false,
    winback_dormancy_days: 60,
    winback_sequence_id: "" as string,
    winback_exclude_recent_days: 90,
  });

  useEffect(() => {
    (async () => {
      try {
        const [s, q] = await Promise.all([
          api("/api/growth/settings"),
          api("/api/followups/sequences"),
        ]);
        const st = s.settings ?? {};
        setForm({
          winback_enabled: !!st.winback_enabled,
          winback_dormancy_days: st.winback_dormancy_days ?? 60,
          winback_sequence_id: st.winback_sequence_id ?? "",
          winback_exclude_recent_days: st.winback_exclude_recent_days ?? 90,
        });
        setSeqs((q.sequences ?? []).filter((x: WinbackSeq) => x.kind === "winback"));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api("/api/growth/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          winback_enabled: form.winback_enabled,
          winback_dormancy_days: form.winback_dormancy_days,
          winback_sequence_id: form.winback_sequence_id || null,
          winback_exclude_recent_days: form.winback_exclude_recent_days,
        }),
      });
      toast.success("Win-back settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className={`flex items-center gap-2 ${MUTED} py-12 justify-center`}>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className={`${INK} text-base`}>Win-back automation</CardTitle>
        <p className={`${MUTED} text-sm mt-1`}>
          Contacts with no invoice, payment, or inbound message in N days are auto-enrolled
          into a win-back sequence. Opted-out contacts are never touched; contacts
          win-backed in the last exclusion window are skipped. Enrollments flow through
          the follow-up engine, so quiet hours, daily caps, and reply-pause apply.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        <div className="flex items-center justify-between">
          <Label className={INK}>Enable win-back</Label>
          <Switch
            checked={form.winback_enabled}
            onCheckedChange={(v) => setForm({ ...form, winback_enabled: v })}
            disabled={!canEdit}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className={MUTED}>Dormancy (days)</Label>
            <Input
              className={INPUT}
              type="number"
              min={7}
              max={365}
              value={form.winback_dormancy_days}
              disabled={!canEdit}
              onChange={(e) =>
                setForm({ ...form, winback_dormancy_days: Number(e.target.value) })
              }
            />
          </div>
          <div className="space-y-2">
            <Label className={MUTED}>Don’t re-nag within (days)</Label>
            <Input
              className={INPUT}
              type="number"
              min={0}
              max={365}
              value={form.winback_exclude_recent_days}
              disabled={!canEdit}
              onChange={(e) =>
                setForm({ ...form, winback_exclude_recent_days: Number(e.target.value) })
              }
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label className={MUTED}>Win-back sequence</Label>
          <Select
            value={form.winback_sequence_id || "none"}
            disabled={!canEdit}
            onValueChange={(v) =>
              setForm({ ...form, winback_sequence_id: !v || v === "none" ? "" : v })
            }
          >
            <SelectTrigger className={INPUT}>
              <SelectValue placeholder="Pick a win-back sequence" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {seqs.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                  {s.active ? "" : " (inactive)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {seqs.length === 0 && (
            <p className={`${MUTED} text-xs`}>
              No win-back sequences yet — create one under Follow-ups with kind “winback”.
            </p>
          )}
        </div>
        <Button className={BTN_PRIMARY} onClick={save} disabled={!canEdit || saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          Save settings
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------- Reviews tab ----------------

interface ReviewRow {
  id: string;
  due_at: string;
  status: string;
  sent_at: string | null;
  contacts: { name: string | null };
  invoices: { number: string };
}

function ReviewsTab() {
  const canEdit = useCan("edit-settings");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    review_enabled: false,
    review_delay_days: 2,
    review_template: "",
  });
  const [queue, setQueue] = useState<ReviewRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [s, q] = await Promise.all([
          api("/api/growth/settings"),
          api("/api/growth/reviews?limit=50"),
        ]);
        const st = s.settings ?? {};
        setForm({
          review_enabled: !!st.review_enabled,
          review_delay_days: st.review_delay_days ?? 2,
          review_template: st.review_template ?? "",
        });
        setQueue(q.reviews ?? []);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api("/api/growth/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          review_enabled: form.review_enabled,
          review_delay_days: form.review_delay_days,
          review_template: form.review_template,
        }),
      });
      toast.success("Review settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className={`flex items-center gap-2 ${MUTED} py-12 justify-center`}>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );

  return (
    <div className="space-y-6">
      <Card className={CARD}>
        <CardHeader>
          <CardTitle className={`${INK} text-base`}>Review requests</CardTitle>
          <p className={`${MUTED} text-sm mt-1`}>
            When an invoice flips to paid, a review request is queued and sent after the
            delay. Template supports {"{{name}}"} and {"{{business}}"}. Click tracking is
            not supported by the send provider — “sent” is the final tracked state.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 max-w-xl">
          <div className="flex items-center justify-between">
            <Label className={INK}>Enable review requests</Label>
            <Switch
              checked={form.review_enabled}
              onCheckedChange={(v) => setForm({ ...form, review_enabled: v })}
              disabled={!canEdit}
            />
          </div>
          <div className="space-y-2">
            <Label className={MUTED}>Delay after payment (days)</Label>
            <Input
              className={INPUT}
              type="number"
              min={0}
              max={30}
              value={form.review_delay_days}
              disabled={!canEdit}
              onChange={(e) =>
                setForm({ ...form, review_delay_days: Number(e.target.value) })
              }
            />
          </div>
          <div className="space-y-2">
            <Label className={MUTED}>Template</Label>
            <Textarea
              className={`${INPUT} min-h-24`}
              value={form.review_template}
              disabled={!canEdit}
              onChange={(e) => setForm({ ...form, review_template: e.target.value })}
            />
          </div>
          <Button className={BTN_PRIMARY} onClick={save} disabled={!canEdit || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save settings
          </Button>
        </CardContent>
      </Card>

      <Card className={CARD}>
        <CardHeader>
          <CardTitle className={`${INK} text-base`}>Request queue</CardTitle>
        </CardHeader>
        <CardContent>
          {queue.length === 0 ? (
            <p className={`${MUTED} py-6 text-center text-sm`}>
              Nothing queued yet. Paid invoices will appear here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={MUTED}>Contact</TableHead>
                  <TableHead className={MUTED}>Invoice</TableHead>
                  <TableHead className={MUTED}>Due</TableHead>
                  <TableHead className={MUTED}>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className={INK}>{r.contacts?.name || "—"}</TableCell>
                    <TableCell className={MUTED}>{r.invoices?.number}</TableCell>
                    <TableCell className={MUTED}>
                      {new Date(r.due_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${REVIEW_STATUS[r.status] ?? ""} border`}>
                        {r.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------- Referrals tab ----------------

interface ReferralRow {
  id: string;
  code: string;
  status: string;
  reward_note: string | null;
  created_at: string;
  referrer_contact_id: string;
  referee_lead_id: string | null;
  referee_contact_id: string | null;
}

function ReferralsTab() {
  const canEdit = useCan("edit-settings");
  const [rows, setRows] = useState<ReferralRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState("");
  const [resolving, setResolving] = useState(false);
  const [minted, setMinted] = useState<{ name: string | null; code: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await api("/api/growth/referrals?limit=100");
      setRows(body.referrals ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load referrals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const generate = async () => {
    if (!phone.trim()) return;
    setResolving(true);
    setMinted(null);
    try {
      const r = await api(`/api/growth/contacts/resolve?phone=${encodeURIComponent(phone)}`);
      const body = await api("/api/growth/referrals/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: r.contact.id }),
      });
      setMinted({ name: r.contact.name, code: body.code });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate code");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className={CARD}>
        <CardHeader>
          <CardTitle className={`${INK} text-base`}>Referral codes</CardTitle>
          <p className={`${MUTED} text-sm mt-1`}>
            One unique code per contact. New leads that sign up with a code are logged
            automatically.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label className={MUTED}>Contact phone</Label>
            <Input
              className={`${INPUT} w-56`}
              placeholder="+91 98100 00000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <Button className={BTN_PRIMARY} onClick={generate} disabled={!canEdit || resolving}>
            {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />}
            <span className="ml-2">Generate code</span>
          </Button>
          {minted && (
            <div className={`${INK} text-sm`}>
              Code for <strong>{minted.name || "contact"}</strong>:{" "}
              <span className="font-mono font-bold text-[#4F46E5]">{minted.code}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={CARD}>
        <CardHeader>
          <CardTitle className={`${INK} text-base`}>Referral log</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className={`flex items-center gap-2 ${MUTED} py-8 justify-center`}>
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className={`${MUTED} py-6 text-center text-sm`}>No referrals recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={MUTED}>Code</TableHead>
                  <TableHead className={MUTED}>Referee</TableHead>
                  <TableHead className={MUTED}>Status</TableHead>
                  <TableHead className={MUTED}>Reward note</TableHead>
                  <TableHead className={MUTED}>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className={`${INK} font-mono font-semibold`}>{r.code}</TableCell>
                    <TableCell className={`${MUTED} text-sm`}>
                      {r.referee_contact_id
                        ? `Contact ${r.referee_contact_id.slice(0, 8)}…`
                        : r.referee_lead_id
                          ? `Lead ${r.referee_lead_id.slice(0, 8)}…`
                          : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-sky-50 text-sky-700 border-sky-200 border">{r.status}</Badge>
                    </TableCell>
                    <TableCell className={`${MUTED} text-sm`}>{r.reward_note || "—"}</TableCell>
                    <TableCell className={`${MUTED} text-sm`}>
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------- Page ----------------

export default function GrowthPage() {
  return (
    <div className={`${PAPER} min-h-screen p-6`}>
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className={`${INK} text-2xl font-bold flex items-center gap-2`}>
            <TrendingUp className="h-6 w-6 text-[#4F46E5]" />
            Growth
          </h1>
          <p className={`${MUTED} text-sm mt-1`}>
            Win back dormant customers, ask for reviews, reward referrals, and score
            every lead — the continuous upsell loop.
          </p>
        </div>

        <Tabs defaultValue="scores">
          <TabsList className={TABS}>
            <TabsTrigger value="scores" className={TAB_TRIGGER}>
              <Star className="h-4 w-4 mr-1.5" /> Lead scores
            </TabsTrigger>
            <TabsTrigger value="winback" className={TAB_TRIGGER}>
              <MessageSquareHeart className="h-4 w-4 mr-1.5" /> Win-back
            </TabsTrigger>
            <TabsTrigger value="reviews" className={TAB_TRIGGER}>
              <BadgePercent className="h-4 w-4 mr-1.5" /> Reviews
            </TabsTrigger>
            <TabsTrigger value="referrals" className={TAB_TRIGGER}>
              <Gift className="h-4 w-4 mr-1.5" /> Referrals
            </TabsTrigger>
          </TabsList>
          <TabsContent value="scores" className="mt-4">
            <ScoresTab />
          </TabsContent>
          <TabsContent value="winback" className="mt-4">
            <WinbackTab />
          </TabsContent>
          <TabsContent value="reviews" className="mt-4">
            <ReviewsTab />
          </TabsContent>
          <TabsContent value="referrals" className="mt-4">
            <ReferralsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
