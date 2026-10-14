// Attendance — monthly team calendar (Module 4).
//
// Light-first premium styling (warm paper, one indigo accent), per
// the standing UI preference. Explicit light colors throughout so
// this surface always renders light, independent of the app theme.
//
// - Top: the caller's own day — one-tap check-in / check-out.
// - Grid: one row per team member, one column per day of the
//   month. Clicking a cell opens a correction dialog (admins may
//   change anyone's record; members see read-only detail for
//   others and can fix their own day).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
} from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
const CARD =
  "bg-white border-[#EAE3D3] rounded-2xl shadow-[0_1px_2px_rgba(28,25,23,0.05)]";
const INPUT =
  "bg-white border-[#E2D9C6] text-[#1C1917] placeholder:text-[#A8A29E] focus-visible:ring-[#4F46E5]";
const BTN_PRIMARY = "bg-[#4F46E5] hover:bg-[#4338CA] text-white";
const BTN_OUTLINE =
  "border-[#E2D9C6] bg-white text-[#44403C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";
const BTN_GHOST = "text-[#78716C] hover:bg-[#F5F1E8] hover:text-[#1C1917]";

const STATUS_META: Record<
  string,
  { label: string; cell: string; chip: string }
> = {
  present: {
    label: "Present",
    cell: "bg-[#DCFCE7] text-[#15803D]",
    chip: "bg-[#DCFCE7] text-[#15803D] border-[#BBF7D0]",
  },
  absent: {
    label: "Absent",
    cell: "bg-[#FEE2E2] text-[#B91C1C]",
    chip: "bg-[#FEE2E2] text-[#B91C1C] border-[#FECACA]",
  },
  half_day: {
    label: "Half day",
    cell: "bg-[#FEF3C7] text-[#B45309]",
    chip: "bg-[#FEF3C7] text-[#B45309] border-[#FDE68A]",
  },
  leave: {
    label: "Leave",
    cell: "bg-[#DBEAFE] text-[#1D4ED8]",
    chip: "bg-[#DBEAFE] text-[#1D4ED8] border-[#BFDBFE]",
  },
};

interface Member {
  user_id: string;
  full_name: string;
  role: string;
}
interface AttendanceRecord {
  id: string;
  user_id: string;
  date: string;
  status: string;
  check_in_at: string | null;
  check_out_at: string | null;
  notes: string | null;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from(
    { length: count },
    (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AttendancePage() {
  const isAdmin = useCan("edit-settings"); // admin+ : correct anyone's record
  const [month, setMonth] = useState(() => {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
    });
    return f.format(new Date());
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [todayRecord, setTodayRecord] = useState<AttendanceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [cellDialog, setCellDialog] = useState<{
    open: boolean;
    member?: Member;
    date?: string;
    record?: AttendanceRecord | null;
  }>({ open: false });

  const days = useMemo(() => daysInMonth(month), [month]);
  const recordByUserDay = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();
    for (const r of records) map.set(`${r.user_id}|${r.date}`, r);
    return map;
  }, [records]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, a, t] = await Promise.all([
        api<{ members: Member[] }>("/api/account/members"),
        api<{ records: AttendanceRecord[] }>(
          `/api/work/attendance?month=${month}`,
        ),
        api<{ record: AttendanceRecord | null }>("/api/work/attendance/today"),
      ]);
      setMembers(m.members);
      setRecords(a.records);
      setTodayRecord(t.record);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    load();
  }, [load]);

  async function selfAction(action: "check_in" | "check_out") {
    setActing(true);
    try {
      const data = await api<{ record: AttendanceRecord }>("/api/work/attendance", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setTodayRecord(data.record);
      toast.success(action === "check_in" ? "Checked in" : "Checked out");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setActing(false);
    }
  }

  const checkedIn = !!todayRecord?.check_in_at;
  const checkedOut = !!todayRecord?.check_out_at;

  if (loading) {
    return (
      <div className={`${PAPER} flex min-h-screen items-center justify-center`}>
        <Loader2 className="h-6 w-6 animate-spin text-[#4F46E5]" />
      </div>
    );
  }

  return (
    <div className={`${PAPER} min-h-screen p-4 lg:p-6`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className={`text-xl font-bold ${INK}`}>Attendance</h1>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            className={BTN_GHOST}
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className={`min-w-32 text-center text-sm font-medium ${INK}`}>
            {new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          </span>
          <Button
            variant="ghost"
            className={BTN_GHOST}
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Self check-in card */}
      <Card className={`${CARD} mb-6`}>
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <div className="flex items-center gap-2">
            <CalendarDays className={`h-5 w-5 ${MUTED}`} />
            <div>
              <p className={`text-sm font-semibold ${INK}`}>Today</p>
              <p className={`text-xs ${MUTED}`}>
                {todayRecord
                  ? `In ${fmtTime(todayRecord.check_in_at)} · Out ${fmtTime(todayRecord.check_out_at)}`
                  : "Not checked in yet"}
              </p>
            </div>
          </div>
          {todayRecord && (
            <Badge className={`${STATUS_META[todayRecord.status]?.chip ?? ""} border`}>
              {STATUS_META[todayRecord.status]?.label ?? todayRecord.status}
            </Badge>
          )}
          <div className="ml-auto flex gap-2">
            {!checkedIn && (
              <Button
                className={BTN_PRIMARY}
                disabled={acting}
                onClick={() => selfAction("check_in")}
              >
                {acting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="mr-1 h-4 w-4" />
                )}
                Check in
              </Button>
            )}
            {checkedIn && !checkedOut && (
              <Button
                variant="outline"
                className={BTN_OUTLINE}
                disabled={acting}
                onClick={() => selfAction("check_out")}
              >
                {acting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="mr-1 h-4 w-4" />
                )}
                Check out
              </Button>
            )}
            {checkedIn && checkedOut && (
              <span className={`text-sm ${MUTED}`}>Day complete — see you tomorrow.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Monthly grid */}
      <Card className={CARD}>
        <CardHeader className="pb-2">
          <CardTitle className={`text-base ${INK}`}>Team calendar</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-xs">
              <thead>
                <tr>
                  <th
                    className={`sticky left-0 z-10 bg-white p-2 text-left font-semibold ${INK}`}
                  >
                    Member
                  </th>
                  {days.map((d) => {
                    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
                    const weekend = dow === 0 || dow === 6;
                    return (
                      <th
                        key={d}
                        className={`p-1 text-center font-medium ${
                          weekend ? "text-[#B45309]" : MUTED
                        }`}
                      >
                        {d.slice(8)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id} className="border-t border-[#F0EADB]">
                    <td className={`sticky left-0 z-10 max-w-40 truncate bg-white p-2 font-medium ${INK}`}>
                      {(m.full_name || "Member").split(" ")[0]}
                    </td>
                    {days.map((d) => {
                      const rec = recordByUserDay.get(`${m.user_id}|${d}`);
                      const meta = rec ? STATUS_META[rec.status] : null;
                      return (
                        <td key={d} className="p-0.5 text-center">
                          <button
                            onClick={() =>
                              setCellDialog({
                                open: true,
                                member: m,
                                date: d,
                                record: rec ?? null,
                              })
                            }
                            title={
                              rec
                                ? `${meta?.label} · in ${fmtTime(rec.check_in_at)} · out ${fmtTime(rec.check_out_at)}`
                                : "No record"
                            }
                            className={`flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-semibold transition-transform hover:scale-110 ${
                              meta ? meta.cell : "bg-[#F5F1E8] text-[#D6CDB8]"
                            }`}
                          >
                            {rec
                              ? rec.status === "present"
                                ? "P"
                                : rec.status === "absent"
                                  ? "A"
                                  : rec.status === "half_day"
                                    ? "½"
                                    : "L"
                              : "·"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={`mt-3 flex flex-wrap gap-3 text-xs ${MUTED}`}>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className={`inline-block h-3 w-3 rounded ${v.cell}`} />
                {v.label}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <CellDialog
        state={cellDialog}
        onClose={() => setCellDialog({ open: false })}
        onSaved={load}
        isAdmin={isAdmin}
      />
    </div>
  );
}

/* ---------------- Cell / correction dialog ---------------- */

function CellDialog({
  state,
  onClose,
  onSaved,
  isAdmin,
}: {
  state: {
    open: boolean;
    member?: Member;
    date?: string;
    record?: AttendanceRecord | null;
  };
  onClose: () => void;
  onSaved: () => void;
  isAdmin: boolean;
}) {
  const [status, setStatus] = useState("present");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state.open) {
      setStatus(state.record?.status ?? "present");
      setNotes(state.record?.notes ?? "");
    }
  }, [state.open, state.record]);

  async function save() {
    if (!state.member?.user_id || !state.date) return;
    setSaving(true);
    try {
      await api("/api/work/attendance", {
        method: "POST",
        body: JSON.stringify({
          user_id: state.member.user_id,
          date: state.date,
          action: "set_status",
          status,
          notes: notes.trim() || undefined,
        }),
      });
      toast.success("Attendance updated");
      onClose();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const rec = state.record;
  const meta = rec ? STATUS_META[rec.status] : null;

  return (
    <Dialog open={state.open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-white">
        <DialogHeader>
          <DialogTitle className={INK}>
            {state.member?.full_name || "Member"} · {state.date}
          </DialogTitle>
          <DialogDescription className={MUTED}>
            {rec ? (
              <>
                {meta?.label} — in {fmtTime(rec.check_in_at)}, out{" "}
                {fmtTime(rec.check_out_at)}
                {rec.notes && <> · note: {rec.notes}</>}
              </>
            ) : (
              "No record for this day."
            )}
          </DialogDescription>
        </DialogHeader>
        {isAdmin ? (
          <div className="grid gap-3">
            <div>
              <Label className={INK}>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v ?? "present")}>
                <SelectTrigger className={INPUT}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_META).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className={INK}>Correction note</Label>
              <Textarea
                className={INPUT}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Why was this corrected?"
              />
            </div>
          </div>
        ) : (
          <p className={`text-sm ${MUTED}`}>
            <Pencil className="mr-1 inline h-3.5 w-3.5" />
            Only admins can correct records. Ask an admin if this day is
            wrong.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" className={BTN_GHOST} onClick={onClose}>
            Close
          </Button>
          {isAdmin && (
            <Button className={BTN_PRIMARY} disabled={saving} onClick={save}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save correction
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
