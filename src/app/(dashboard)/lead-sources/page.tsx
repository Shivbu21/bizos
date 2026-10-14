// Lead Sources — admin page for Module 1 (social lead capture).
//
// Light-first premium styling (warm paper, one indigo accent), per the
// standing UI preference. Explicit light colors are used throughout so
// this surface always renders light, independent of the app's theme.
//
// Three sections:
//   1. Sources — connected inbound providers (Facebook Lead Ads,
//      Justdial, website forms, Instagram). Shows the webhook URL to
//      paste into the provider's dashboard; the HMAC secret is shown
//      exactly once at creation.
//   2. Keyword rules — Instagram comment-to-DM triggers (CRUD).
//   3. Recent leads — the normalized capture stream.

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  KeyRound,
  Loader2,
  Magnet,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

// ---- Light-first design tokens (explicit, theme-independent) ----
const PAPER = "bg-[#FAF6EF]";
const INK = "text-[#1C1917]";
const MUTED = "text-[#78716C]";
const CARD = "bg-white border-[#EAE3D3] rounded-2xl shadow-[0_1px_2px_rgba(28,25,23,0.05)]";
const INPUT = "bg-white border-[#E2D9C6] text-[#1C1917] placeholder:text-[#A8A29E] focus-visible:ring-[#4F46E5]";
const BTN_PRIMARY = "bg-[#4F46E5] hover:bg-[#4338CA] text-white";
const BTN_OUTLINE = "border-[#E2D9C6] bg-white text-[#44403C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";
const BTN_GHOST = "text-[#78716C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";
const ROW_DIVIDER = "border-[#F0EAD9]";

interface LeadSource {
  id: string;
  type: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

interface KeywordRule {
  id: string;
  keyword: string;
  reply_template: string;
  is_active: boolean;
  created_at: string;
}

interface Lead {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  campaign: string | null;
  status: string;
  created_at: string;
  lead_sources: { name: string } | null;
}

const SOURCE_LABELS: Record<string, string> = {
  facebook_lead_ads: "Facebook Lead Ads",
  justdial: "Justdial",
  web_form: "Website form",
  instagram: "Instagram",
};

const STATUS_STYLES: Record<string, string> = {
  new: "bg-sky-50 text-sky-700 border-sky-200",
  contacted: "bg-amber-50 text-amber-700 border-amber-200",
  qualified: "bg-violet-50 text-violet-700 border-violet-200",
  converted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  lost: "bg-stone-100 text-stone-500 border-stone-200",
};

// Module 5 (growth): score badge colors by band.
const SCORE_BADGE: Record<string, string> = {
  hot: "bg-[#FEE2E2] text-[#DC2626] border-[#FECACA]",
  warm: "bg-[#FEF3C7] text-[#B45309] border-[#FDE68A]",
  cold: "bg-[#F5F5F4] text-[#78716C] border-[#E7E5E4]",
};

function scoreBand(score: number): "hot" | "warm" | "cold" {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

const SOURCE_BADGE = "bg-[#EEF1FF] text-[#4338CA] border-[#DDE3FD]";

function webhookUrlFor(source: LeadSource): string {
  if (typeof window === "undefined") return "";
  const base = window.location.origin;
  return source.type === "instagram"
    ? `${base}/api/lead-capture/instagram?source=${source.id}`
    : `${base}/api/lead-capture/webhook?source=${source.id}`;
}

function copyText(text: string, label: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${label} copied`),
    () => toast.error("Copy failed"),
  );
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export default function LeadSourcesPage() {
  const canEdit = useCan("edit-settings");
  const [sources, setSources] = useState<LeadSource[]>([]);
  const [rules, setRules] = useState<KeywordRule[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  // Module 5 (growth): lead_id → cached score for the badges.
  const [leadScores, setLeadScores] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  // Create-source dialog
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [newType, setNewType] = useState("web_form");
  const [newName, setNewName] = useState("");
  const [oneTimeSecrets, setOneTimeSecrets] = useState<{
    secret: string;
    verify_token?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // Keyword rule dialog
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<KeywordRule | null>(null);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [ruleTemplate, setRuleTemplate] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, r, l, sc] = await Promise.all([
        api("/api/lead-sources"),
        api("/api/keyword-rules"),
        api("/api/leads?limit=50"),
        api("/api/growth/scores?limit=200").catch(() => ({ scores: [] })),
      ]);
      setSources(s.lead_sources ?? []);
      setRules(r.keyword_rules ?? []);
      setLeads(l.leads ?? []);
      const map: Record<string, number> = {};
      for (const row of sc.scores ?? []) map[row.lead_id] = row.score;
      setLeadScores(map);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createSource = async () => {
    if (!newName.trim()) {
      toast.error("Give the source a name");
      return;
    }
    setSaving(true);
    try {
      const data = await api("/api/lead-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType, name: newName.trim() }),
      });
      setOneTimeSecrets({
        secret: data.secret,
        verify_token: data.verify_token,
      });
      setNewName("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleSource = async (source: LeadSource, is_active: boolean) => {
    try {
      await api(`/api/lead-sources/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  };

  const deleteSource = async (source: LeadSource) => {
    if (!window.confirm(`Delete source "${source.name}"? Its webhook URL stops working.`)) return;
    try {
      await api(`/api/lead-sources/${source.id}`, { method: "DELETE" });
      toast.success("Source deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const regenerateSecret = async (source: LeadSource) => {
    if (
      !window.confirm(
        "Issue a new webhook secret? The provider's current configuration will stop working until you update it.",
      )
    )
      return;
    try {
      const data = await api(`/api/lead-sources/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate_secret: true }),
      });
      setOneTimeSecrets({ secret: data.secret });
      toast.success("New secret issued — shown once below");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  const openRuleDialog = (rule: KeywordRule | null) => {
    setEditingRule(rule);
    setRuleKeyword(rule?.keyword ?? "");
    setRuleTemplate(rule?.reply_template ?? "");
    setRuleDialogOpen(true);
  };

  const saveRule = async () => {
    if (!ruleKeyword.trim()) {
      toast.error("Keyword is required");
      return;
    }
    setSaving(true);
    try {
      if (editingRule) {
        await api(`/api/keyword-rules/${editingRule.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword: ruleKeyword.trim(),
            reply_template: ruleTemplate.trim() || undefined,
          }),
        });
      } else {
        await api("/api/keyword-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword: ruleKeyword.trim(),
            reply_template: ruleTemplate.trim() || undefined,
          }),
        });
      }
      setRuleDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule: KeywordRule, is_active: boolean) => {
    try {
      await api(`/api/keyword-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  };

  const deleteRule = async (rule: KeywordRule) => {
    if (!window.confirm(`Delete rule "${rule.keyword}"?`)) return;
    try {
      await api(`/api/keyword-rules/${rule.id}`, { method: "DELETE" });
      toast.success("Rule deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  if (loading) {
    return (
      <div className={`-m-4 flex h-64 items-center justify-center sm:-m-6 ${PAPER}`}>
        <Loader2 className="h-6 w-6 animate-spin text-[#4F46E5]" />
      </div>
    );
  }

  return (
    <div className={`-m-4 min-h-full sm:-m-6 ${PAPER}`}>
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#4F46E5]">
            Capture
          </p>
          <h1 className={`mt-1 text-2xl font-semibold tracking-tight ${INK}`}>
            Lead Sources
          </h1>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Connect inbound lead providers and Instagram keyword triggers.
            Captured leads land in one normalized stream below.
          </p>
        </div>

        {oneTimeSecrets && (
          <Card className="rounded-2xl border-[#F0D48A] bg-[#FFFBEB] shadow-[0_1px_2px_rgba(28,25,23,0.05)]">
            <CardHeader>
              <CardTitle className={`flex items-center gap-2 text-base ${INK}`}>
                <KeyRound className="h-4 w-4 text-[#B45309]" />
                Webhook credentials — shown once
              </CardTitle>
              <CardDescription className="text-[#92700F]">
                Copy these into the provider&apos;s dashboard now. They are
                stored encrypted and can never be read back.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div>
                <Label className="text-xs text-[#78716C]">HMAC secret (X-Signature header)</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input value={oneTimeSecrets.secret} readOnly className={`font-mono text-xs ${INPUT}`} />
                  <Button
                    variant="outline"
                    size="icon"
                    className={BTN_OUTLINE}
                    onClick={() => copyText(oneTimeSecrets.secret, "Secret")}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {oneTimeSecrets.verify_token && (
                <div>
                  <Label className="text-xs text-[#78716C]">Meta hub.verify_token</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input value={oneTimeSecrets.verify_token} readOnly className={`font-mono text-xs ${INPUT}`} />
                    <Button
                      variant="outline"
                      size="icon"
                      className={BTN_OUTLINE}
                      onClick={() => copyText(oneTimeSecrets.verify_token!, "Verify token")}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              <Button variant="ghost" size="sm" className={`self-start ${BTN_GHOST}`} onClick={() => setOneTimeSecrets(null)}>
                I&apos;ve saved them — dismiss
              </Button>
            </CardContent>
          </Card>
        )}

        <Card className={CARD}>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className={`text-base ${INK}`}>Connected sources</CardTitle>
              <CardDescription className={MUTED}>
                Paste each webhook URL into the provider&apos;s dashboard.
                Inbound payloads are HMAC-verified before ingestion.
              </CardDescription>
            </div>
            {canEdit && (
              <Button size="sm" className={BTN_PRIMARY} onClick={() => setSourceDialogOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> Add source
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {sources.length === 0 ? (
              <p className={`py-8 text-center text-sm ${MUTED}`}>
                No sources connected yet. Add your first provider to start capturing leads.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {sources.map((source) => (
                  <div
                    key={source.id}
                    className="flex flex-col gap-2 rounded-xl border border-[#EFE8D8] bg-[#FDFBF6] p-4"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={SOURCE_BADGE}>
                        {SOURCE_LABELS[source.type] ?? source.type}
                      </Badge>
                      <span className={`text-sm font-medium ${INK}`}>{source.name}</span>
                      {!source.is_active && (
                        <Badge variant="outline" className="bg-stone-100 text-stone-500 border-stone-200">
                          paused
                        </Badge>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        {canEdit && (
                          <>
                            <Switch
                              checked={source.is_active}
                              onCheckedChange={(v) => void toggleSource(source, v)}
                              aria-label={`Toggle ${source.name}`}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className={BTN_GHOST}
                              title="Issue new webhook secret"
                              onClick={() => void regenerateSecret(source)}
                            >
                              <KeyRound className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={BTN_GHOST}
                              title="Delete source"
                              onClick={() => void deleteSource(source)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        value={webhookUrlFor(source)}
                        readOnly
                        className={`font-mono text-xs ${INPUT}`}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        className={BTN_OUTLINE}
                        onClick={() => copyText(webhookUrlFor(source), "Webhook URL")}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={CARD}>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className={`flex items-center gap-2 text-base ${INK}`}>
                <Magnet className="h-4 w-4 text-[#4F46E5]" />
                Instagram keyword rules
              </CardTitle>
              <CardDescription className={MUTED}>
                When a comment contains the keyword, a lead is created and a
                DM reply is queued. DM delivery needs Meta credentials
                (see MODULE1.md).
              </CardDescription>
            </div>
            {canEdit && (
              <Button size="sm" className={BTN_PRIMARY} onClick={() => openRuleDialog(null)}>
                <Plus className="mr-1 h-4 w-4" /> Add rule
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {rules.length === 0 ? (
              <p className={`py-8 text-center text-sm ${MUTED}`}>
                No keyword rules yet. Try one for &quot;PRICE&quot;.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className={`hover:bg-transparent ${ROW_DIVIDER}`}>
                    <TableHead className={MUTED}>Keyword</TableHead>
                    <TableHead className={MUTED}>Reply template</TableHead>
                    <TableHead className={MUTED}>Active</TableHead>
                    {canEdit && <TableHead className="w-20" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((rule) => (
                    <TableRow key={rule.id} className={`${ROW_DIVIDER} hover:bg-[#FAF6EF]`}>
                      <TableCell>
                        <code className="rounded-md bg-[#EEF1FF] px-2 py-1 text-xs font-semibold text-[#4338CA]">
                          {rule.keyword}
                        </code>
                      </TableCell>
                      <TableCell className={`max-w-xs truncate text-sm ${MUTED}`}>
                        {rule.reply_template}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={rule.is_active}
                          disabled={!canEdit}
                          onCheckedChange={(v) => void toggleRule(rule, v)}
                          aria-label={`Toggle rule ${rule.keyword}`}
                        />
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className={BTN_GHOST}
                              onClick={() => openRuleDialog(rule)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={BTN_GHOST}
                              onClick={() => void deleteRule(rule)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className={CARD}>
          <CardHeader>
            <CardTitle className={`text-base ${INK}`}>Recent captured leads</CardTitle>
            <CardDescription className={MUTED}>
              The normalized lead stream, newest first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {leads.length === 0 ? (
              <p className={`py-8 text-center text-sm ${MUTED}`}>
                No leads captured yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className={`hover:bg-transparent ${ROW_DIVIDER}`}>
                      <TableHead className={MUTED}>Name</TableHead>
                      <TableHead className={MUTED}>Phone</TableHead>
                      <TableHead className={MUTED}>Email</TableHead>
                      <TableHead className={MUTED}>Source</TableHead>
                      <TableHead className={MUTED}>Status</TableHead>
                      <TableHead className={MUTED}>Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leads.map((lead) => (
                      <TableRow key={lead.id} className={`${ROW_DIVIDER} hover:bg-[#FAF6EF]`}>
                        <TableCell className={`font-medium ${INK}`}>{lead.name ?? "—"}</TableCell>
                        <TableCell className={`font-mono text-xs ${INK}`}>{lead.phone ?? "—"}</TableCell>
                        <TableCell className={`text-sm ${MUTED}`}>{lead.email ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={SOURCE_BADGE}>
                            {SOURCE_LABELS[lead.source] ?? lead.source}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={STATUS_STYLES[lead.status] ?? "bg-stone-100 text-stone-500 border-stone-200"}
                          >
                            {lead.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {leadScores[lead.id] !== undefined ? (
                            <Badge
                              variant="outline"
                              className={`${SCORE_BADGE[scoreBand(leadScores[lead.id])]} font-semibold`}
                            >
                              {leadScores[lead.id]}
                            </Badge>
                          ) : (
                            <span className={`text-xs ${MUTED}`}>—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={sourceDialogOpen} onOpenChange={setSourceDialogOpen}>
        <DialogContent className="border-[#EAE3D3] bg-white text-[#1C1917]">
          <DialogHeader>
            <DialogTitle className={INK}>Add lead source</DialogTitle>
            <DialogDescription className={MUTED}>
              The webhook URL and secret are issued after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label className={INK}>Provider</Label>
              <Select value={newType} onValueChange={(v) => setNewType(v ?? "web_form")}>
                <SelectTrigger className={INPUT}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-[#EAE3D3] bg-white text-[#1C1917]">
                  <SelectItem value="web_form">Website contact form</SelectItem>
                  <SelectItem value="facebook_lead_ads">Facebook Lead Ads</SelectItem>
                  <SelectItem value="justdial">Justdial</SelectItem>
                  <SelectItem value="instagram">Instagram (comment-to-DM)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className={INK}>Name</Label>
              <Input
                placeholder="e.g. Homepage contact form"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className={INPUT}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className={BTN_OUTLINE} onClick={() => setSourceDialogOpen(false)}>
              Cancel
            </Button>
            <Button className={BTN_PRIMARY} onClick={() => void createSource()} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Create source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <DialogContent className="border-[#EAE3D3] bg-white text-[#1C1917]">
          <DialogHeader>
            <DialogTitle className={INK}>{editingRule ? "Edit keyword rule" : "Add keyword rule"}</DialogTitle>
            <DialogDescription className={MUTED}>
              Matched case-insensitively as a substring of the comment text.
              Use {"{{name}}"} in the reply template for the commenter&apos;s handle.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label className={INK}>Keyword</Label>
              <Input
                placeholder="e.g. PRICE"
                value={ruleKeyword}
                onChange={(e) => setRuleKeyword(e.target.value)}
                className={INPUT}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className={INK}>DM reply template</Label>
              <Textarea
                placeholder="Hi {{name}}! Thanks for your interest — we will DM you the details shortly."
                value={ruleTemplate}
                onChange={(e) => setRuleTemplate(e.target.value)}
                rows={3}
                className={INPUT}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className={BTN_OUTLINE} onClick={() => setRuleDialogOpen(false)}>
              Cancel
            </Button>
            <Button className={BTN_PRIMARY} onClick={() => void saveRule()} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {editingRule ? "Save changes" : "Add rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
