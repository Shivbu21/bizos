// Work — kanban execution boards (Module 4).
//
// Light-first premium styling (warm paper, one indigo accent), per
// the standing UI preference. Explicit light colors throughout so
// this surface always renders light, independent of the app theme.
//
// Drag-and-drop uses the HTML5 draggable API (no extra deps):
// drop on a column appends, drop on a card inserts before it.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  Link2,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  User,
  X,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
const OVERDUE_CARD = "border-[#FCA5A5] bg-[#FFF7F7]";
// Select sentinel for "none" — Radix Select items need a non-empty
// value, so empty selections round-trip through this constant.
const NONE = "__none";
const OVERDUE_CHIP = "bg-[#FEE2E2] text-[#B91C1C] border-[#FECACA]";

interface Board {
  id: string;
  name: string;
  description: string | null;
}
interface Column {
  id: string;
  board_id: string;
  name: string;
  position: number;
  is_done: boolean;
}
interface WorkCard {
  id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string | null;
  assignee_user_id: string | null;
  due_date: string | null;
  position: string | number;
  lead_id: string | null;
  invoice_id: string | null;
}
interface CardComment {
  id: string;
  card_id: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
}
interface Member {
  user_id: string;
  full_name: string;
  role: string;
}
interface Lead {
  id: string;
  name: string | null;
  phone: string | null;
  status: string | null;
}
interface Invoice {
  id: string;
  number: string;
  buyer_name: string;
  status: string;
  total_paise: number;
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

function memberName(members: Member[], userId: string | null): string {
  if (!userId) return "Unassigned";
  return members.find((m) => m.user_id === userId)?.full_name || "Unknown";
}

export default function WorkPage() {
  const canManage = useCan("edit-settings"); // admin+ : boards/columns structure
  const isViewer = useCan("view-only");
  const canWorkCards = !isViewer; // agent+ : cards/comments

  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [cards, setCards] = useState<WorkCard[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [dropColumnId, setDropColumnId] = useState<string | null>(null);

  // Dialogs
  const [boardDialog, setBoardDialog] = useState(false);
  const [columnDialog, setColumnDialog] = useState<{
    open: boolean;
    column?: Column;
  }>({ open: false });
  const [cardDialog, setCardDialog] = useState<{
    open: boolean;
    card?: WorkCard;
    columnId?: string;
  }>({ open: false });

  const loadBoards = useCallback(async () => {
    const data = await api<{ boards: Board[] }>("/api/work/boards");
    setBoards(data.boards);
    if (!activeBoardId && data.boards.length > 0) {
      setActiveBoardId(data.boards[0].id);
    }
  }, [activeBoardId]);

  const loadBoard = useCallback(async (boardId: string) => {
    const data = await api<{ columns: Column[]; cards: WorkCard[] }>(
      `/api/work/boards/${boardId}`,
    );
    setColumns(data.columns);
    setCards(data.cards);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [m, l, i] = await Promise.all([
        api<{ members: Member[] }>("/api/account/members"),
        api<{ leads: Lead[] }>("/api/leads"),
        api<{ invoices: Invoice[] }>("/api/billing/invoices"),
      ]);
      setMembers(m.members);
      setLeads(l.leads ?? []);
      setInvoices(i.invoices ?? []);
      await loadBoards();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [loadBoards]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (activeBoardId) loadBoard(activeBoardId).catch(() => {});
  }, [activeBoardId, loadBoard]);

  const doneColumnIds = useMemo(
    () => new Set(columns.filter((c) => c.is_done).map((c) => c.id)),
    [columns],
  );
  const today = useMemo(() => {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return f.format(new Date());
  }, []);
  const overdueIds = useMemo(
    () =>
      new Set(
        cards
          .filter(
            (c) =>
              c.due_date !== null &&
              c.due_date < today &&
              !doneColumnIds.has(c.column_id),
          )
          .map((c) => c.id),
      ),
    [cards, doneColumnIds, today],
  );

  const cardsByColumn = useMemo(() => {
    const map = new Map<string, WorkCard[]>();
    for (const c of columns) map.set(c.id, []);
    for (const card of cards) {
      const list = map.get(card.column_id);
      if (list) list.push(card);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(a.position) - Number(b.position));
    }
    return map;
  }, [columns, cards]);

  // ---- Drag and drop ----
  async function handleDrop(columnId: string, beforeCardId?: string) {
    if (!dragCardId || !activeBoardId) return;
    const list = cardsByColumn.get(columnId) ?? [];
    const others = list.filter((c) => c.id !== dragCardId);
    const toIndex = beforeCardId
      ? others.findIndex((c) => c.id === beforeCardId)
      : others.length;
    setDragCardId(null);
    setDropColumnId(null);
    try {
      await api(`/api/work/boards/${activeBoardId}/cards/${dragCardId}/move`, {
        method: "POST",
        body: JSON.stringify({
          column_id: columnId,
          to_index: Math.max(0, toIndex),
        }),
      });
      await loadBoard(activeBoardId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
      if (activeBoardId) loadBoard(activeBoardId).catch(() => {});
    }
  }

  // ---- Board actions ----
  async function createBoard(name: string, description: string) {
    try {
      const data = await api<{ board: Board }>("/api/work/boards", {
        method: "POST",
        body: JSON.stringify({ name, description: description || null }),
      });
      toast.success("Board created");
      setBoardDialog(false);
      await loadBoards();
      setActiveBoardId(data.board.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    }
  }

  // ---- Column actions ----
  async function saveColumn(name: string, isDone: boolean, editing?: Column) {
    if (!activeBoardId) return;
    try {
      if (editing) {
        await api(
          `/api/work/boards/${activeBoardId}/columns/${editing.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ name, is_done: isDone }),
          },
        );
      } else {
        await api(`/api/work/boards/${activeBoardId}/columns`, {
          method: "POST",
          body: JSON.stringify({ name, is_done: isDone }),
        });
      }
      toast.success(editing ? "Column renamed" : "Column added");
      setColumnDialog({ open: false });
      await loadBoard(activeBoardId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function deleteColumn(column: Column) {
    if (!activeBoardId) return;
    const count = (cardsByColumn.get(column.id) ?? []).length;
    if (count > 0) {
      toast.error(
        "Column has cards — move them out first, then delete it.",
      );
      return;
    }
    if (!confirm(`Delete column "${column.name}"?`)) return;
    try {
      await api(
        `/api/work/boards/${activeBoardId}/columns/${column.id}`,
        { method: "DELETE", body: JSON.stringify({}) },
      );
      toast.success("Column deleted");
      await loadBoard(activeBoardId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function deleteCard(card: WorkCard) {
    if (!activeBoardId) return;
    if (!confirm(`Delete card "${card.title}"?`)) return;
    try {
      await api(`/api/work/boards/${activeBoardId}/cards/${card.id}`, {
        method: "DELETE",
      });
      toast.success("Card deleted");
      setCardDialog({ open: false });
      await loadBoard(activeBoardId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  if (loading) {
    return (
      <div className={`${PAPER} flex min-h-screen items-center justify-center`}>
        <Loader2 className="h-6 w-6 animate-spin text-[#4F46E5]" />
      </div>
    );
  }

  return (
    <div className={`${PAPER} min-h-screen p-4 lg:p-6`}>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className={`text-xl font-bold ${INK}`}>Work</h1>
        {overdueIds.size > 0 && (
          <Badge className={`${OVERDUE_CHIP} border`}>
            <AlertTriangle className="mr-1 h-3 w-3" />
            {overdueIds.size} overdue
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={activeBoardId ?? ""}
            onValueChange={(v) => setActiveBoardId(v)}
          >
            <SelectTrigger className={`${INPUT} w-52`}>
              <SelectValue placeholder="Select board" />
            </SelectTrigger>
            <SelectContent>
              {boards.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canManage && (
            <Button className={BTN_PRIMARY} onClick={() => setBoardDialog(true)}>
              <Plus className="mr-1 h-4 w-4" /> New board
            </Button>
          )}
        </div>
      </div>

      {!activeBoardId ? (
        <Card className={CARD}>
          <CardContent className="py-12 text-center">
            <p className={MUTED}>
              No boards yet. Create one to start tracking work.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((col) => {
            const list = cardsByColumn.get(col.id) ?? [];
            const overdueHere = list.filter((c) => overdueIds.has(c.id)).length;
            return (
              <div
                key={col.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropColumnId(col.id);
                }}
                onDragLeave={() => setDropColumnId((v) => (v === col.id ? null : v))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(col.id);
                }}
                className={`w-72 shrink-0 rounded-2xl border p-3 transition-colors ${
                  dropColumnId === col.id
                    ? "border-[#4F46E5] bg-[#EEF2FF]"
                    : "border-[#EAE3D3] bg-[#F5F1E8]"
                }`}
              >
                <div className="mb-3 flex items-center gap-2 px-1">
                  <h2 className={`text-sm font-semibold ${INK}`}>{col.name}</h2>
                  <Badge variant="outline" className="border-[#E2D9C6] text-[#78716C]">
                    {list.length}
                  </Badge>
                  {overdueHere > 0 && (
                    <Badge className={`${OVERDUE_CHIP} border`}>
                      {overdueHere} overdue
                    </Badge>
                  )}
                  {col.is_done && (
                    <Badge className="border-[#BBF7D0] bg-[#F0FDF4] text-[#15803D]">
                      <Check className="mr-1 h-3 w-3" /> done
                    </Badge>
                  )}
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className={`ml-auto rounded p-1 ${BTN_GHOST}`}
                        aria-label="Column options"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          onClick={() => setColumnDialog({ open: true, column: col })}
                        >
                          <Pencil className="mr-2 h-4 w-4" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-[#BE123C]"
                          onClick={() => deleteColumn(col)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  {list.map((card) => (
                    <div
                      key={card.id}
                      draggable={canWorkCards}
                      onDragStart={() => setDragCardId(card.id)}
                      onDragEnd={() => {
                        setDragCardId(null);
                        setDropColumnId(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDrop(col.id, card.id);
                      }}
                      onClick={() => setCardDialog({ open: true, card })}
                      className={`cursor-pointer rounded-xl border p-3 shadow-sm transition-shadow hover:shadow ${
                        overdueIds.has(card.id) ? OVERDUE_CARD : "border-[#EAE3D3] bg-white"
                      } ${dragCardId === card.id ? "opacity-40" : ""}`}
                    >
                      <p className={`text-sm font-medium ${INK}`}>{card.title}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {card.due_date && (
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] ${
                              overdueIds.has(card.id)
                                ? OVERDUE_CHIP
                                : "border-[#E2D9C6] text-[#78716C]"
                            }`}
                          >
                            <Clock className="mr-1 h-3 w-3" />
                            {card.due_date}
                          </span>
                        )}
                        <span className="inline-flex items-center rounded-full border border-[#E2D9C6] px-1.5 py-0.5 text-[11px] text-[#78716C]">
                          <User className="mr-1 h-3 w-3" />
                          {memberName(members, card.assignee_user_id).split(" ")[0]}
                        </span>
                        {(card.lead_id || card.invoice_id) && (
                          <span className="inline-flex items-center rounded-full border border-[#C7D2FE] bg-[#EEF2FF] px-1.5 py-0.5 text-[11px] text-[#4338CA]">
                            <Link2 className="mr-1 h-3 w-3" />
                            linked
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {canWorkCards && (
                    <button
                      onClick={() =>
                        setCardDialog({ open: true, columnId: col.id })
                      }
                      className={`flex items-center justify-center gap-1 rounded-xl border border-dashed border-[#D6CDB8] py-2 text-sm ${MUTED} hover:bg-white`}
                    >
                      <Plus className="h-4 w-4" /> Add card
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {canManage && (
            <button
              onClick={() => setColumnDialog({ open: true })}
              className={`h-12 w-72 shrink-0 rounded-2xl border border-dashed border-[#D6CDB8] text-sm ${MUTED} hover:bg-white`}
            >
              <Plus className="mr-1 inline h-4 w-4" /> Add column
            </button>
          )}
        </div>
      )}

      {/* Tasks strip */}
      <TaskStrip canWorkCards={canWorkCards} members={members} />

      <BoardDialog
        open={boardDialog}
        onClose={() => setBoardDialog(false)}
        onSave={createBoard}
      />
      <ColumnDialog
        state={columnDialog}
        onClose={() => setColumnDialog({ open: false })}
        onSave={saveColumn}
      />
      <CardDialog
        state={cardDialog}
        onClose={() => setCardDialog({ open: false })}
        onSaved={() => {
          setCardDialog({ open: false });
          if (activeBoardId) loadBoard(activeBoardId);
        }}
        onDelete={deleteCard}
        members={members}
        leads={leads}
        invoices={invoices}
        canWorkCards={canWorkCards}
        canManage={canManage}
        activeBoardId={activeBoardId}
      />
    </div>
  );
}

/* ---------------- Board dialog ---------------- */

function BoardDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open ]);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-white">
        <DialogHeader>
          <DialogTitle className={INK}>New board</DialogTitle>
          <DialogDescription className={MUTED}>
            Boards start with To do / In progress / Done columns. Rename or
            add columns any time.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label className={INK}>Name</Label>
            <Input
              className={INPUT}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Client delivery"
            />
          </div>
          <div>
            <Label className={INK}>Description</Label>
            <Textarea
              className={INPUT}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What flows through this board?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" className={BTN_GHOST} onClick={onClose}>
            Cancel
          </Button>
          <Button
            className={BTN_PRIMARY}
            disabled={!name.trim()}
            onClick={() => onSave(name.trim(), description.trim())}
          >
            Create board
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Column dialog ---------------- */

function ColumnDialog({
  state,
  onClose,
  onSave,
}: {
  state: { open: boolean; column?: Column };
  onClose: () => void;
  onSave: (name: string, isDone: boolean, editing?: Column) => void;
}) {
  const [name, setName] = useState("");
  const [isDone, setIsDone] = useState(false);
  useEffect(() => {
    if (state.open) {
      setName(state.column?.name ?? "");
      setIsDone(state.column?.is_done ?? false);
    }
  }, [state.open, state.column]);
  return (
    <Dialog open={state.open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-white">
        <DialogHeader>
          <DialogTitle className={INK}>
            {state.column ? "Rename column" : "Add column"}
          </DialogTitle>
          <DialogDescription className={MUTED}>
            Cards in a "Done" column are excluded from overdue counts.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label className={INK}>Name</Label>
            <Input
              className={INPUT}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Review"
            />
          </div>
          <label className={`flex items-center gap-2 text-sm ${INK}`}>
            <input
              type="checkbox"
              checked={isDone}
              onChange={(e) => setIsDone(e.target.checked)}
              className="h-4 w-4 accent-[#4F46E5]"
            />
            This is a "Done" column
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" className={BTN_GHOST} onClick={onClose}>
            Cancel
          </Button>
          <Button
            className={BTN_PRIMARY}
            disabled={!name.trim()}
            onClick={() => onSave(name.trim(), isDone, state.column)}
          >
            {state.column ? "Save" : "Add column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Card dialog ---------------- */

function CardDialog({
  state,
  onClose,
  onSaved,
  onDelete,
  members,
  leads,
  invoices,
  canWorkCards,
  canManage,
  activeBoardId,
}: {
  state: { open: boolean; card?: WorkCard; columnId?: string };
  onClose: () => void;
  onSaved: () => void;
  onDelete: (card: WorkCard) => void;
  members: Member[];
  leads: Lead[];
  invoices: Invoice[];
  canWorkCards: boolean;
  canManage: boolean;
  activeBoardId: string | null;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [leadId, setLeadId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [comments, setComments] = useState<CardComment[]>([]);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state.open) return;
    const c = state.card;
    setTitle(c?.title ?? "");
    setDescription(c?.description ?? "");
    setAssignee(c?.assignee_user_id ?? "");
    setDueDate(c?.due_date ?? "");
    setLeadId(c?.lead_id ?? "");
    setInvoiceId(c?.invoice_id ?? "");
    setComment("");
    if (c && activeBoardId) {
      api<{ comments: CardComment[] }>(
        `/api/work/boards/${activeBoardId}/cards/${c.id}/comments`,
      )
        .then((d) => setComments(d.comments))
        .catch(() => setComments([]));
    } else {
      setComments([]);
    }
  }, [state.open, state.card, activeBoardId]);

  async function save() {
    if (!title.trim() || !activeBoardId) return;
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        assignee_user_id: assignee || null,
        due_date: dueDate || null,
        lead_id: leadId || null,
        invoice_id: invoiceId || null,
      };
      if (state.card) {
        await api(`/api/work/boards/${activeBoardId}/cards/${state.card.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await api(`/api/work/boards/${activeBoardId}/cards`, {
          method: "POST",
          body: JSON.stringify({ ...payload, column_id: state.columnId }),
        });
      }
      toast.success(state.card ? "Card updated" : "Card created");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function addComment() {
    if (!comment.trim() || !state.card || !activeBoardId) return;
    try {
      const data = await api<{ comment: CardComment }>(
        `/api/work/boards/${activeBoardId}/cards/${state.card.id}/comments`,
        { method: "POST", body: JSON.stringify({ body: comment.trim() }) },
      );
      setComments((prev) => [...prev, data.comment]);
      setComment("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Comment failed");
    }
  }

  const linkedLead = leads.find((l) => l.id === leadId);
  const linkedInvoice = invoices.find((i) => i.id === invoiceId);

  return (
    <Dialog open={state.open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-white sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className={INK}>
            {state.card ? "Card details" : "New card"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label className={INK}>Title</Label>
            <Input
              className={INPUT}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!canWorkCards}
            />
          </div>
          <div>
            <Label className={INK}>Description</Label>
            <Textarea
              className={INPUT}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canWorkCards}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className={INK}>Assignee</Label>
              <Select
                value={assignee || NONE}
                onValueChange={(v) => setAssignee(!v || v === NONE ? "" : v)}
                disabled={!canWorkCards}
              >
                <SelectTrigger className={INPUT}>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name || m.user_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className={INK}>Due date</Label>
              <Input
                type="date"
                className={INPUT}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={!canWorkCards}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className={INK}>Linked lead</Label>
              <Select
                value={leadId || NONE}
                onValueChange={(v) => setLeadId(!v || v === NONE ? "" : v)}
                disabled={!canWorkCards}
              >
                <SelectTrigger className={INPUT}>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {leads.slice(0, 100).map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {(l.name || l.phone || "Lead").slice(0, 30)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {linkedLead && (
                <p className={`mt-1 text-xs ${MUTED}`}>
                  {linkedLead.name} · {linkedLead.phone} · {linkedLead.status}
                </p>
              )}
            </div>
            <div>
              <Label className={INK}>Linked invoice</Label>
              <Select
                value={invoiceId || NONE}
                onValueChange={(v) => setInvoiceId(!v || v === NONE ? "" : v)}
                disabled={!canWorkCards}
              >
                <SelectTrigger className={INPUT}>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {invoices.slice(0, 100).map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.number} · {i.buyer_name.slice(0, 20)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {linkedInvoice && (
                <p className={`mt-1 text-xs ${MUTED}`}>
                  {linkedInvoice.number} · ₹
                  {(linkedInvoice.total_paise / 100).toLocaleString("en-IN")} ·{" "}
                  {linkedInvoice.status}
                </p>
              )}
            </div>
          </div>

          {state.card && (
            <div>
              <Label className={INK}>
                <MessageSquare className="mr-1 inline h-3.5 w-3.5" />
                Comments
              </Label>
              <div className="mt-1 max-h-40 space-y-2 overflow-y-auto rounded-xl border border-[#EAE3D3] bg-[#FAF6EF] p-2">
                {comments.length === 0 && (
                  <p className={`text-xs ${MUTED}`}>No comments yet.</p>
                )}
                {comments.map((c) => (
                  <div key={c.id} className="rounded-lg bg-white p-2 text-sm">
                    <p className={`text-xs ${MUTED}`}>
                      {memberName(members, c.author_user_id)} ·{" "}
                      {new Date(c.created_at).toLocaleString()}
                    </p>
                    <p className={INK}>{c.body}</p>
                  </div>
                ))}
              </div>
              {canWorkCards && (
                <div className="mt-2 flex gap-2">
                  <Input
                    className={INPUT}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Add a comment…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addComment();
                    }}
                  />
                  <Button className={BTN_PRIMARY} onClick={addComment}>
                    Post
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="flex items-center justify-between">
          <div>
            {state.card && canManage && (
              <Button
                variant="outline"
                className={BTN_DANGER}
                onClick={() => state.card && onDelete(state.card)}
              >
                <Trash2 className="mr-1 h-4 w-4" /> Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" className={BTN_GHOST} onClick={onClose}>
              {canWorkCards ? "Cancel" : "Close"}
            </Button>
            {canWorkCards && (
              <Button className={BTN_PRIMARY} disabled={saving || !title.trim()} onClick={save}>
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {state.card ? "Save" : "Create"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Tasks strip ---------------- */

interface Task {
  id: string;
  title: string;
  description: string | null;
  assignee_user_id: string | null;
  due_at: string | null;
  done: boolean;
  reminder_at: string | null;
}

function TaskStrip({
  canWorkCards,
  members,
}: {
  canWorkCards: boolean;
  members: Member[];
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [reminders, setReminders] = useState<Task[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ tasks: Task[] }>("/api/work/tasks?open=true");
      setTasks(data.tasks);
      const r = await api<{ tasks: Task[] }>("/api/work/tasks?reminder_due=true");
      setReminders(r.tasks);
    } catch {
      /* tasks are a secondary strip — never block the page */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addTask() {
    if (!newTitle.trim()) return;
    try {
      await api("/api/work/tasks", {
        method: "POST",
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      setNewTitle("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    }
  }

  async function complete(id: string) {
    try {
      await api(`/api/work/tasks/${id}/complete`, { method: "POST" });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Complete failed");
    }
  }

  return (
    <Card className={`${CARD} mt-6`}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className={`text-base ${INK}`}>
          Tasks
          {reminders.length > 0 && (
            <Badge className={`${OVERDUE_CHIP} ml-2 border`}>
              {reminders.length} reminder{reminders.length === 1 ? "" : "s"} due
            </Badge>
          )}
        </CardTitle>
        <CalendarDays className={`h-4 w-4 ${MUTED}`} />
      </CardHeader>
      <CardContent>
        {canWorkCards && (
          <div className="mb-3 flex gap-2">
            <Input
              className={INPUT}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="New task… (e.g. Call the printer about receipts)"
              onKeyDown={(e) => {
                if (e.key === "Enter") addTask();
              }}
            />
            <Button className={BTN_PRIMARY} onClick={addTask}>
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
        )}
        {tasks.length === 0 ? (
          <p className={`text-sm ${MUTED}`}>All clear — no open tasks.</p>
        ) : (
          <ul className="divide-y divide-[#F0EADB]">
            {tasks.slice(0, 12).map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2">
                {canWorkCards ? (
                  <button
                    onClick={() => complete(t.id)}
                    aria-label="Mark complete"
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-[#D6CDB8] text-transparent hover:border-[#4F46E5] hover:text-[#4F46E5]"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span className="h-5 w-5 rounded-full border border-[#D6CDB8]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm ${INK}`}>{t.title}</p>
                  <p className={`text-xs ${MUTED}`}>
                    {memberName(members, t.assignee_user_id)}
                    {t.due_at &&
                      ` · due ${new Date(t.due_at).toLocaleDateString()}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
