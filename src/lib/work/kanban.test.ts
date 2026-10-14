// Kanban ordering unit tests — fractional position math, move
// validation, overdue derivation.

import { describe, expect, it } from "vitest";
import {
  POSITION_GAP,
  deriveOverdue,
  needsRebalance,
  positionBetween,
  positionForIndex,
  rebalancePositions,
  todayYmd,
  validateColumnMove,
} from "./kanban";

describe("positionBetween", () => {
  it("empty column starts at the gap", () => {
    expect(positionBetween(null, null)).toBe(POSITION_GAP);
  });

  it("appends after the last card", () => {
    expect(positionBetween(2048, null)).toBe(2048 + POSITION_GAP);
  });

  it("prepends before the first card", () => {
    expect(positionBetween(null, 1024)).toBe(1024 - POSITION_GAP);
  });

  it("splits between two cards at the midpoint", () => {
    expect(positionBetween(1024, 2048)).toBe(1536);
  });
});

describe("positionForIndex", () => {
  const cards = [
    { id: "a", position: 1024 },
    { id: "b", position: 2048 },
    { id: "c", position: 3072 },
  ];

  it("moves to the start", () => {
    // b (excluded from the list) dropped at index 0
    const rest = cards.filter((c) => c.id !== "b");
    expect(positionForIndex(rest, 0)).toBe(1024 - POSITION_GAP);
  });

  it("moves to the end", () => {
    const rest = cards.filter((c) => c.id !== "a");
    expect(positionForIndex(rest, 2)).toBe(3072 + POSITION_GAP);
  });

  it("moves between two cards", () => {
    const rest = cards.filter((c) => c.id !== "c");
    expect(positionForIndex(rest, 1)).toBe(1536);
  });

  it("clamps an out-of-range index to the end", () => {
    const rest = cards.filter((c) => c.id !== "a");
    expect(positionForIndex(rest, 99)).toBe(3072 + POSITION_GAP);
  });

  it("clamps a negative index to the start", () => {
    const rest = cards.filter((c) => c.id !== "c");
    expect(positionForIndex(rest, -5)).toBe(1024 - POSITION_GAP);
  });
});

describe("needsRebalance / rebalancePositions", () => {
  it("detects a tight gap", () => {
    expect(needsRebalance([1024, 1024 + 1e-9])).toBe(true);
  });

  it("passes healthy gaps", () => {
    expect(needsRebalance([1024, 2048, 2560])).toBe(false);
  });

  it("rebalances to clean integer slots preserving order", () => {
    const map = rebalancePositions([
      { id: "x", position: 1.5 },
      { id: "y", position: 1.5000001 },
    ]);
    expect(map.get("x")).toBe(POSITION_GAP);
    expect(map.get("y")).toBe(2 * POSITION_GAP);
  });
});

describe("validateColumnMove", () => {
  const columns = [
    { id: "c1", board_id: "b1" },
    { id: "c2", board_id: "b1" },
    { id: "c9", board_id: "b2" },
  ];

  it("accepts a move within the same board", () => {
    expect(validateColumnMove("b1", "c2", columns)).toBeNull();
  });

  it("rejects an unknown column", () => {
    expect(validateColumnMove("b1", "nope", columns)).toBe(
      "Target column does not exist",
    );
  });

  it("rejects a column from another board", () => {
    expect(validateColumnMove("b1", "c9", columns)).toBe(
      "Target column belongs to a different board",
    );
  });
});

describe("deriveOverdue", () => {
  const done = new Set(["done-col"]);
  const cards = [
    { id: "late", due_date: "2026-10-10", column_id: "todo" },
    { id: "today", due_date: "2026-10-14", column_id: "todo" },
    { id: "future", due_date: "2026-10-20", column_id: "todo" },
    { id: "no-due", due_date: null, column_id: "todo" },
    { id: "done-late", due_date: "2026-10-01", column_id: "done-col" },
  ];

  it("flags only past-due cards outside Done", () => {
    expect(deriveOverdue(cards, done, "2026-10-14")).toEqual(["late"]);
  });

  it("treats today as not overdue", () => {
    expect(deriveOverdue(cards, done, "2026-10-15")).toEqual([
      "late",
      "today",
    ]);
  });
});

describe("todayYmd", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(todayYmd()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
