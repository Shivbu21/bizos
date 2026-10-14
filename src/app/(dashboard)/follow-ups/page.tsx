// Follow-ups — admin page for Module 3 (drip follow-up sequencer).
//
// Light-first premium styling (warm paper, one indigo accent), per the
// standing UI preference. Explicit light colors throughout so this
// surface always renders light, independent of the app's theme.
//
// Three views (tabs):
//   1. Sequences — sequence cards + visual step builder (day offsets,
//      message templates with {{name}}/{{business}}, live preview).
//   2. Enrollments — contact journeys with status, pause/resume/cancel,
//      and a per-enrollment timeline dialog.

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Clock,
  Loader2,
  MessagesSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  UserPlus,
  XCircle,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { createClient } from "@/lib/supabase/client";
import { renderTemplate } from "@/lib/followups/scheduler";
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
const BTN_GHOST = "text-[#78716C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";
const BTN_DANGER =
  "border-[#FECDD3] bg-white text-[#BE123C] hover:bg-[#FFF1F2]";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  paused: "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-sky-50 text-sky-700 border-sky-200",
  opted_out: "bg-rose-50 text-rose-700 border-rose-200",
  cancelled: "bg-stone-100 text-stone-500 border-stone-200",
};

const EVENT_STYLES: Record<string, string> = {
  sent: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200",
  enrolled: "bg-sky-50 text-sky-700 border-sky-200",
  paused_on_reply: "bg-amber-50 text-amber-700 border-amber-200",
  paused: "bg-amber-50 text-amber-700 border-amber-200",
  resumed: "bg-sky-50 text-sky-700 border-sky-200",
  opted_out: "bg-rose-50 text-rose-700 border-rose-200",
  completed: "bg-violet-50 text-violet-700 border-violet-200",
  cancelled: "bg-stone-100 text-stone-500 border-stone-200",
};

const EVENT_LABELS: Record<string, string> = {
  sent: "Message sent",
  failed: "Send failed",
  enrolled: "Enrolled",
  paused_on_reply: "Paused — contact replied",
  paused: "Paused manually",
  resumed: "Resumed",
  opted_out: "Opted out (STOP)",
  completed: "Sequence completed",
  cancelled: "Cancelled",
};

interface Sequence {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  active: boolean;
  daily_send_cap: number;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
  created_at: string;
}

interface Step {
  id: string;
  sequence_id: string;
  step_order: number;
  day_offset: number;
  channel: string;
  message_template: string;
  fallback: string | null;
}

interface Enrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  status: string;
  current_step: number;
  enrolled_at: string;
  next_due_at: string | null;
  last_sent_at: string | null;
  contacts: { id: string; name: string | null; phone: string } | null;
  followup_sequences: { id: string; name: string } | null;
}

interface TimelineEvent {
  id: string;
  step_id: string | null;
  status: string;
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
  sequence_steps: { step_order: number; message_template: string } | null;
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FollowUpsPage() {
  const canEditSettings = useCan("edit-settings");
  const [tab, setTab] = useState("sequences");
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<Sequence | null>(null);
  const [loading, setLoading] = useState(true);

  // Sequence dialog
  const [seqDialog, setSeqDialog] = useState(false);
  const [editingSeq, setEditingSeq] = useState<Sequence | null>(null);
  const [seqForm, setSeqForm] = useState({
    name: "",
    description: "",
    kind: "drip",
    active: true,
    daily_send_cap: "50",
    quiet_start: "21:00",
    quiet_end: "09:00",
    timezone: "Asia/Kolkata",
  });

  // Step dialog
  const [stepDialog, setStepDialog] = useState(false);
  const [editingStep, setEditingStep] = useState<Step | null>(null);
  const [stepForm, setStepForm] = useState({
    day_offset: "1",
    message_template: "",
    fallback: "",
  });

  // Enroll dialog
  const [enrollDialog, setEnrollDialog] = useState(false);
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<ContactRow[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactRow | null>(null);

  // Timeline dialog
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineEnrollment, setTimelineEnrollment] = useState<Enrollment | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);

  const [statusFilter, setStatusFilter] = useState("all");

  const loadSequences = useCallback(async () => {
    const res = await fetch("/api/followups/sequences");
    const json = await res.json().catch(() => null);
    if (res.ok) setSequences(json.sequences ?? []);
    else toast.error(json?.error ?? "Failed to load sequences");
  }, []);

  const loadSteps = useCallback(async (sequenceId: string) => {
    const res = await fetch(`/api/followups/sequences/${sequenceId}/steps`);
    const json = await res.json().catch(() => null);
    if (res.ok) setSteps(json.steps ?? []);
    else toast.error(json?.error ?? "Failed to load steps");
  }, []);

  const loadEnrollments = useCallback(async () => {
    const params = statusFilter !== "all" ? `?status=${statusFilter}` : "";
    const res = await fetch(`/api/followups/enrollments${params}`);
    const json = await res.json().catch(() => null);
    if (res.ok) setEnrollments(json.enrollments ?? []);
    else toast.error(json?.error ?? "Failed to load enrollments");
  }, [statusFilter]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadSequences(), loadEnrollments()]);
    setLoading(false);
  }, [loadSequences, loadEnrollments]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedSeq) loadSteps(selectedSeq.id);
    else setSteps([]);
  }, [selectedSeq, loadSteps]);

  // ---- sequences ----
  function openNewSequence() {
    setEditingSeq(null);
    setSeqForm({
      name: "",
      description: "",
      kind: "drip",
      active: true,
      daily_send_cap: "50",
      quiet_start: "21:00",
      quiet_end: "09:00",
      timezone: "Asia/Kolkata",
    });
    setSeqDialog(true);
  }

  function openEditSequence(seq: Sequence) {
    setEditingSeq(seq);
    setSeqForm({
      name: seq.name,
      description: seq.description ?? "",
      kind: seq.kind ?? "drip",
      active: seq.active,
      daily_send_cap: String(seq.daily_send_cap),
      quiet_start: seq.quiet_start,
      quiet_end: seq.quiet_end,
      timezone: seq.timezone,
    });
    setSeqDialog(true);
  }

  async function saveSequence() {
    const payload = {
      name: seqForm.name,
      description: seqForm.description || null,
      kind: seqForm.kind,
      active: seqForm.active,
      daily_send_cap: Number(seqForm.daily_send_cap),
      quiet_start: seqForm.quiet_start,
      quiet_end: seqForm.quiet_end,
      timezone: seqForm.timezone,
    };
    const res = await fetch(
      editingSeq
        ? `/api/followups/sequences/${editingSeq.id}`
        : "/api/followups/sequences",
      {
        method: editingSeq ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error ?? "Failed to save sequence");
      return;
    }
    toast.success(editingSeq ? "Sequence updated" : "Sequence created");
    setSeqDialog(false);
    await loadSequences();
    if (editingSeq) setSelectedSeq(json.sequence);
  }

  async function deleteSequence(seq: Sequence) {
    if (!window.confirm(`Delete "${seq.name}" and all its steps? Enrollments are kept.`)) return;
    const res = await fetch(`/api/followups/sequences/${seq.id}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error ?? "Failed to delete");
      return;
    }
    toast.success("Sequence deleted");
    if (selectedSeq?.id === seq.id) setSelectedSeq(null);
    await loadSequences();
  }

  async function toggleSequenceActive(seq: Sequence) {
    const res = await fetch(`/api/followups/sequences/${seq.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !seq.active }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error ?? "Failed to update");
      return;
    }
    setSequences((s) => s.map((x) => (x.id === seq.id ? json.sequence : x)));
    if (selectedSeq?.id === seq.id) setSelectedSeq(json.sequence);
  }

  // ---- steps ----
  function openNewStep() {
    setEditingStep(null);
    setStepForm({ day_offset: "1", message_template: "", fallback: "" });
    setStepDialog(true);
  }

  function openEditStep(step: Step) {
    setEditingStep(step);
    setStepForm({
      day_offset: String(step.day_offset),
      message_template: step.message_template,
      fallback: step.fallback ?? "",
    });
    setStepDialog(true);
  }

  async function saveStep() {
    if (!selectedSeq) return;
    const payload = {
      day_offset: Number(stepForm.day_offset),
      message_template: stepForm.message_template,
      fallback: stepForm.fallback || null,
    };
    const url = editingStep
      ? `/api/followups/sequences/${selectedSeq.id}/steps/${editingStep.id}`
      : `/api/followups/sequences/${selectedSeq.id}/steps`;
    const res = await fetch(url, {
      method: editingStep ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error ?? "Failed to save step");
      return;
    }
    toast.success(editingStep ? "Step updated" : "Step added");
    setStepDialog(false);
    await loadSteps(selectedSeq.id);
  }

  async function deleteStep(step: Step) {
    if (!selectedSeq) return;
    if (!window.confirm(`Delete step ${step.step_order + 1}? In-flight enrollments keep their index.`)) return;
    const res = await fetch(
      `/api/followups/sequences/${selectedSeq.id}/steps/${step.id}`,
      { method: "DELETE" },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error ?? "Failed to delete step");
      return;
    }
    toast.success("Step deleted");
    await loadSteps(selectedSeq.id);
  }

  // ---- enrollments ----
  async function searchContacts(term: string) {
    setContactSearch(term);
    if (term.trim().length < 2) {
      setContactResults([]);
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase
      .from("contacts")
      .select("id, name, phone")
      .or(`name.ilike.%${term}%,phone.ilike.%${term}%`)
      .order("name")
      .limit(20);
    if (error) {
      toast.error("Contact search failed");
      return;
    }
    setContactResults((data ?? []) as ContactRow[]);
  }

  async function enroll() {
    if (!enrollSeqId || !selectedContact) {
      toast.error("Pick a sequence and a contact");
      return;
    }
    const res = await fetch("/api/followups/enrollments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sequence_id: enrollSeqId,
        contact_id: selectedContact.id,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error ?? "Failed to enroll");
      return;
    }
    toast.success("Contact enrolled");
    setEnrollDialog(false);
    setSelectedContact(null);
    setContactSearch("");
    setContactResults([]);
    await loadEnrollments();
  }

  async function enrollmentAction(id: string, action: "pause" | "resume" | "cancel") {
    const res = await fetch(`/api/followups/enrollments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(json?.error ?? "Action failed");
      return;
    }
    toast.success(
      action === "pause" ? "Enrollment paused" : action === "resume" ? "Enrollment resumed" : "Enrollment cancelled",
    );
    await loadEnrollments();
  }

  async function openTimeline(enrollment: Enrollment) {
    setTimelineEnrollment(enrollment);
    setTimelineOpen(true);
    const res = await fetch(`/api/followups/enrollments/${enrollment.id}`);
    const json = await res.json().catch(() => null);
    if (res.ok) setTimeline(json.timeline ?? []);
    else toast.error(json?.error ?? "Failed to load timeline");
  }

  return (
    <div className={`min-h-screen ${PAPER} ${INK} px-6 py-8`}>
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Follow-ups</h1>
            <p className={`mt-1 text-sm ${MUTED}`}>
              Multi-day drip sequences. A human reply pauses the drip; STOP opts the contact out for good.
            </p>
          </div>
          <MessagesSquare className="h-8 w-8 text-[#4F46E5]" />
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-white border border-[#EAE3D3]">
            <TabsTrigger value="sequences">Sequences</TabsTrigger>
            <TabsTrigger value="enrollments">Enrollments</TabsTrigger>
          </TabsList>

          <TabsContent value="sequences" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
              {/* Sequence list */}
              <Card className={CARD}>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <CardTitle className="text-base">Sequences</CardTitle>
                  {canEditSettings && (
                    <Button size="sm" className={BTN_PRIMARY} onClick={openNewSequence}>
                      <Plus className="mr-1 h-4 w-4" /> New
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-2">
                  {loading && <Loader2 className="h-5 w-5 animate-spin text-[#78716C]" />}
                  {!loading && sequences.length === 0 && (
                    <p className={`text-sm ${MUTED}`}>No sequences yet. Create one to start dripping.</p>
                  )}
                  {sequences.map((seq) => (
                    <button
                      key={seq.id}
                      onClick={() => setSelectedSeq(seq)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        selectedSeq?.id === seq.id
                          ? "border-[#4F46E5] bg-[#EEF1FF]"
                          : "border-[#EAE3D3] bg-white hover:bg-[#FDFBF6]"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{seq.name}</span>
                        <div className="flex items-center gap-1.5">
                          {seq.kind === "winback" && (
                            <Badge variant="outline" className="bg-[#EEF1FF] text-[#4338CA] border-[#DDE3FD]">
                              win-back
                            </Badge>
                          )}
                          <Badge variant="outline" className={seq.active ? STATUS_STYLES.active : STATUS_STYLES.cancelled}>
                            {seq.active ? "Active" : "Paused"}
                          </Badge>
                        </div>
                      </div>
                      <div className={`mt-1 flex items-center gap-3 text-xs ${MUTED}`}>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> quiet {seq.quiet_start}–{seq.quiet_end}
                        </span>
                        <span>cap {seq.daily_send_cap === 0 ? "∞" : seq.daily_send_cap}/day</span>
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>

              {/* Step builder */}
              <Card className={CARD}>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <CardTitle className="text-base">
                    {selectedSeq ? `Steps — ${selectedSeq.name}` : "Step builder"}
                  </CardTitle>
                  {selectedSeq && canEditSettings && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className={BTN_OUTLINE} onClick={() => openEditSequence(selectedSeq)}>
                        <Pencil className="mr-1 h-4 w-4" /> Settings
                      </Button>
                      <Button size="sm" className={BTN_PRIMARY} onClick={openNewStep}>
                        <Plus className="mr-1 h-4 w-4" /> Add step
                      </Button>
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  {!selectedSeq && (
                    <p className={`text-sm ${MUTED}`}>Select a sequence to build its drip steps.</p>
                  )}
                  {selectedSeq && steps.length === 0 && (
                    <p className={`text-sm ${MUTED}`}>No steps yet. Add the first message of the drip.</p>
                  )}
                  <div className="space-y-3">
                    {steps.map((step) => (
                      <div key={step.id} className="rounded-xl border border-[#EAE3D3] bg-white p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <Badge variant="outline" className="bg-[#EEF1FF] text-[#4338CA] border-[#DDE3FD]">
                              Step {step.step_order + 1} · Day {step.day_offset}
                            </Badge>
                            <p className="mt-2 whitespace-pre-wrap text-sm">{step.message_template}</p>
                            <p className={`mt-2 rounded-lg bg-[#FDFBF6] p-2 text-xs ${MUTED}`}>
                              Preview:{" "}
                              {renderTemplate(step.message_template, {
                                name: "Asha",
                                business: "your business",
                              })}
                            </p>
                          </div>
                          {canEditSettings && (
                            <div className="flex shrink-0 gap-1">
                              <Button size="icon" variant="ghost" className={BTN_GHOST} onClick={() => openEditStep(step)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="text-[#BE123C] hover:bg-[#FFF1F2]" onClick={() => deleteStep(step)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {selectedSeq && canEditSettings && (
                    <div className="mt-4 flex items-center justify-between border-t border-[#F0EAD9] pt-4">
                      <div className="flex items-center gap-2 text-sm">
                        <Switch
                          checked={selectedSeq.active}
                          onCheckedChange={() => toggleSequenceActive(selectedSeq)}
                        />
                        <span>{selectedSeq.active ? "Sequence live" : "Sequence paused"}</span>
                      </div>
                      <Button size="sm" variant="outline" className={BTN_DANGER} onClick={() => deleteSequence(selectedSeq)}>
                        <Trash2 className="mr-1 h-4 w-4" /> Delete sequence
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="enrollments" className="mt-6">
            <Card className={CARD}>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base">Enrollments</CardTitle>
                  <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
                    <SelectTrigger className={`w-40 ${INPUT}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="opted_out">Opted out</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" className={BTN_PRIMARY} onClick={() => { setEnrollSeqId(sequences[0]?.id ?? ""); setEnrollDialog(true); }}>
                  <UserPlus className="mr-1 h-4 w-4" /> Enroll contact
                </Button>
              </CardHeader>
              <CardContent>
                {loading && <Loader2 className="h-5 w-5 animate-spin text-[#78716C]" />}
                {!loading && enrollments.length === 0 && (
                  <p className={`text-sm ${MUTED}`}>No enrollments{statusFilter !== "all" ? " with this status" : ""} yet.</p>
                )}
                {enrollments.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-[#F0EAD9]">
                        <TableHead>Contact</TableHead>
                        <TableHead>Sequence</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Step</TableHead>
                        <TableHead>Next due</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {enrollments.map((e) => (
                        <TableRow key={e.id} className="border-[#F0EAD9]">
                          <TableCell>
                            <button className="text-left hover:underline" onClick={() => openTimeline(e)}>
                              <div className="font-medium">{e.contacts?.name || "Unnamed"}</div>
                              <div className={`text-xs ${MUTED}`}>{e.contacts?.phone}</div>
                            </button>
                          </TableCell>
                          <TableCell className="text-sm">{e.followup_sequences?.name}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={STATUS_STYLES[e.status] ?? STATUS_STYLES.cancelled}>
                              {e.status.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">{e.current_step + 1}</TableCell>
                          <TableCell className="text-sm">{fmtDateTime(e.next_due_at)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              {e.status === "active" && (
                                <Button size="icon" variant="ghost" className={BTN_GHOST} title="Pause" onClick={() => enrollmentAction(e.id, "pause")}>
                                  <Pause className="h-4 w-4" />
                                </Button>
                              )}
                              {e.status === "paused" && (
                                <Button size="icon" variant="ghost" className={BTN_GHOST} title="Resume at next step" onClick={() => enrollmentAction(e.id, "resume")}>
                                  <Play className="h-4 w-4" />
                                </Button>
                              )}
                              {(e.status === "active" || e.status === "paused") && (
                                <Button size="icon" variant="ghost" className="text-[#BE123C] hover:bg-[#FFF1F2]" title="Cancel" onClick={() => enrollmentAction(e.id, "cancel")}>
                                  <XCircle className="h-4 w-4" />
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
        </Tabs>
      </div>

      {/* Sequence dialog */}
      <Dialog open={seqDialog} onOpenChange={setSeqDialog}>
        <DialogContent className="bg-white text-[#1C1917]">
          <DialogHeader>
            <DialogTitle>{editingSeq ? "Edit sequence" : "New sequence"}</DialogTitle>
            <DialogDescription>
              Quiet hours are evaluated in the sequence timezone. Cap 0 means unlimited sends per day.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input className={INPUT} value={seqForm.name} onChange={(e) => setSeqForm({ ...seqForm, name: e.target.value })} placeholder="New-lead nurture" />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea className={INPUT} value={seqForm.description} onChange={(e) => setSeqForm({ ...seqForm, description: e.target.value })} rows={2} />
            </div>
            <div>
              <Label>Sequence kind</Label>
              <Select value={seqForm.kind} onValueChange={(v) => setSeqForm({ ...seqForm, kind: v ?? "drip" })}>
                <SelectTrigger className={INPUT}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="drip">Drip — manual enrollment</SelectItem>
                  <SelectItem value="winback">Win-back — auto-enrolls dormant contacts</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Quiet start (HH:MM)</Label>
                <Input className={INPUT} value={seqForm.quiet_start} onChange={(e) => setSeqForm({ ...seqForm, quiet_start: e.target.value })} placeholder="21:00" />
              </div>
              <div>
                <Label>Quiet end (HH:MM)</Label>
                <Input className={INPUT} value={seqForm.quiet_end} onChange={(e) => setSeqForm({ ...seqForm, quiet_end: e.target.value })} placeholder="09:00" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Daily send cap</Label>
                <Input className={INPUT} type="number" min={0} value={seqForm.daily_send_cap} onChange={(e) => setSeqForm({ ...seqForm, daily_send_cap: e.target.value })} />
              </div>
              <div>
                <Label>Timezone</Label>
                <Input className={INPUT} value={seqForm.timezone} onChange={(e) => setSeqForm({ ...seqForm, timezone: e.target.value })} placeholder="Asia/Kolkata" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={seqForm.active} onCheckedChange={(v) => setSeqForm({ ...seqForm, active: v })} />
              <Label>Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className={BTN_OUTLINE} onClick={() => setSeqDialog(false)}>Cancel</Button>
            <Button className={BTN_PRIMARY} onClick={saveSequence}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step dialog */}
      <Dialog open={stepDialog} onOpenChange={setStepDialog}>
        <DialogContent className="bg-white text-[#1C1917]">
          <DialogHeader>
            <DialogTitle>{editingStep ? "Edit step" : "Add step"}</DialogTitle>
            <DialogDescription>
              Use {"{{name}}"} for the contact's name and {"{{business}}"} for your business name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Day offset (days after enrollment)</Label>
              <Input className={INPUT} type="number" min={0} value={stepForm.day_offset} onChange={(e) => setStepForm({ ...stepForm, day_offset: e.target.value })} />
            </div>
            <div>
              <Label>Message template</Label>
              <Textarea className={INPUT} rows={4} value={stepForm.message_template} onChange={(e) => setStepForm({ ...stepForm, message_template: e.target.value })} placeholder="Hi {{name}}, just checking in from {{business}}…" />
            </div>
            {stepForm.message_template && (
              <p className={`rounded-lg bg-[#FDFBF6] p-2 text-xs ${MUTED}`}>
                Preview: {renderTemplate(stepForm.message_template, { name: "Asha", business: "your business" })}
              </p>
            )}
            <div>
              <Label>Fallback (optional)</Label>
              <Textarea className={INPUT} rows={2} value={stepForm.fallback} onChange={(e) => setStepForm({ ...stepForm, fallback: e.target.value })} placeholder="Shorter variant if the primary template can't be used" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className={BTN_OUTLINE} onClick={() => setStepDialog(false)}>Cancel</Button>
            <Button className={BTN_PRIMARY} onClick={saveStep}>Save step</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enroll dialog */}
      <Dialog open={enrollDialog} onOpenChange={setEnrollDialog}>
        <DialogContent className="bg-white text-[#1C1917]">
          <DialogHeader>
            <DialogTitle>Enroll contact</DialogTitle>
            <DialogDescription>The journey starts at step 1 on the next cron run.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Sequence</Label>
              <Select value={enrollSeqId} onValueChange={(v) => setEnrollSeqId(v ?? "")}>
                <SelectTrigger className={INPUT}>
                  <SelectValue placeholder="Choose a sequence" />
                </SelectTrigger>
                <SelectContent>
                  {sequences.filter((s) => s.active).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Contact (search by name or phone)</Label>
              <Input className={INPUT} value={contactSearch} onChange={(e) => searchContacts(e.target.value)} placeholder="Type at least 2 characters…" />
              {contactResults.length > 0 && (
                <div className="mt-1 max-h-40 overflow-auto rounded-xl border border-[#EAE3D3]">
                  {contactResults.map((c) => (
                    <button
                      key={c.id}
                      className={`block w-full px-3 py-2 text-left text-sm hover:bg-[#FDFBF6] ${selectedContact?.id === c.id ? "bg-[#EEF1FF]" : ""}`}
                      onClick={() => setSelectedContact(c)}
                    >
                      <span className="font-medium">{c.name || "Unnamed"}</span>
                      <span className={`ml-2 text-xs ${MUTED}`}>{c.phone}</span>
                    </button>
                  ))}
                </div>
              )}
              {selectedContact && (
                <p className="mt-2 text-sm">
                  Selected: <span className="font-medium">{selectedContact.name || "Unnamed"}</span>
                  <span className={`ml-2 text-xs ${MUTED}`}>{selectedContact.phone}</span>
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className={BTN_OUTLINE} onClick={() => setEnrollDialog(false)}>Cancel</Button>
            <Button className={BTN_PRIMARY} onClick={enroll}>Enroll</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Timeline dialog */}
      <Dialog open={timelineOpen} onOpenChange={setTimelineOpen}>
        <DialogContent className="bg-white text-[#1C1917] max-w-lg">
          <DialogHeader>
            <DialogTitle>Journey timeline</DialogTitle>
            <DialogDescription>
              {timelineEnrollment?.contacts?.name || "Unnamed"} · {timelineEnrollment?.followup_sequences?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 space-y-2 overflow-auto">
            {timeline.length === 0 && <p className={`text-sm ${MUTED}`}>No events yet.</p>}
            {timeline.map((ev) => (
              <div key={ev.id} className="flex items-start justify-between gap-3 rounded-xl border border-[#F0EAD9] p-3">
                <div>
                  <Badge variant="outline" className={EVENT_STYLES[ev.status] ?? STATUS_STYLES.cancelled}>
                    {EVENT_LABELS[ev.status] ?? ev.status}
                  </Badge>
                  {ev.sequence_steps && (
                    <p className="mt-1 text-xs text-[#78716C]">
                      Step {ev.sequence_steps.step_order + 1}: {ev.sequence_steps.message_template.slice(0, 80)}
                      {ev.sequence_steps.message_template.length > 80 ? "…" : ""}
                    </p>
                  )}
                  {ev.error && <p className="mt-1 text-xs text-rose-700">{ev.error}</p>}
                  {ev.provider_message_id && (
                    <p className="mt-1 font-mono text-[10px] text-[#A8A29E]">{ev.provider_message_id}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-[#A8A29E]">{fmtDateTime(ev.created_at)}</span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
