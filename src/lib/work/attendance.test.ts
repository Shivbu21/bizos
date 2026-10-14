// Attendance + task helper unit tests — upsert payloads, guard
// rails, reminder derivation, date/month parsing.

import { describe, expect, it } from "vitest";
import {
  buildAttendanceUpsert,
  canSelfManageAttendance,
  isAttendanceStatus,
  parseDateParam,
  parseMonthParam,
  taskReminderDue,
} from "./attendance";

const NOW = "2026-10-14T09:00:00.000Z";

describe("isAttendanceStatus", () => {
  it("accepts the four statuses", () => {
    for (const s of ["present", "absent", "half_day", "leave"]) {
      expect(isAttendanceStatus(s)).toBe(true);
    }
  });
  it("rejects anything else", () => {
    expect(isAttendanceStatus("sick")).toBe(false);
    expect(isAttendanceStatus(null)).toBe(false);
  });
});

describe("buildAttendanceUpsert", () => {
  it("check_in stamps the time and forces present", () => {
    const p = buildAttendanceUpsert("check_in", null, { nowIso: NOW });
    expect(p).toEqual({ status: "present", check_in_at: NOW });
  });

  it("a second check_in keeps the first stamp", () => {
    const p = buildAttendanceUpsert(
      "check_in",
      { check_in_at: "2026-10-14T08:00:00.000Z", check_out_at: null },
      { nowIso: NOW },
    );
    expect(p.check_in_at).toBe("2026-10-14T08:00:00.000Z");
  });

  it("check_out requires an existing check-in", () => {
    expect(() =>
      buildAttendanceUpsert("check_out", null, { nowIso: NOW }),
    ).toThrow("Cannot check out before checking in");
  });

  it("check_out stamps the time", () => {
    const p = buildAttendanceUpsert(
      "check_out",
      { check_in_at: "2026-10-14T08:00:00.000Z", check_out_at: null },
      { nowIso: NOW },
    );
    expect(p).toEqual({ check_out_at: NOW });
  });

  it("check_out before check-in is rejected", () => {
    expect(() =>
      buildAttendanceUpsert(
        "check_out",
        { check_in_at: NOW, check_out_at: null },
        { nowIso: "2026-10-14T07:00:00.000Z" },
      ),
    ).toThrow("Check-out time cannot be before check-in time");
  });

  it("set_status accepts a valid status", () => {
    const p = buildAttendanceUpsert("set_status", null, {
      nowIso: NOW,
      status: "leave",
    });
    expect(p).toEqual({ status: "leave" });
  });

  it("set_status rejects an invalid status", () => {
    expect(() =>
      buildAttendanceUpsert("set_status", null, {
        nowIso: NOW,
        status: "holiday",
      }),
    ).toThrow("status must be present, absent, half_day, or leave");
  });
});

describe("canSelfManageAttendance", () => {
  it("self is allowed", () => {
    expect(canSelfManageAttendance("u1", "u1")).toBe(true);
  });
  it("others are not", () => {
    expect(canSelfManageAttendance("u1", "u2")).toBe(false);
  });
});

describe("taskReminderDue", () => {
  it("fires when the reminder time has passed and the task is open", () => {
    expect(
      taskReminderDue({ reminder_at: "2026-10-14T08:00:00.000Z", done: false }, NOW),
    ).toBe(true);
  });
  it("does not fire in the future", () => {
    expect(
      taskReminderDue({ reminder_at: "2026-10-14T10:00:00.000Z", done: false }, NOW),
    ).toBe(false);
  });
  it("never fires for completed tasks", () => {
    expect(
      taskReminderDue({ reminder_at: "2026-10-14T08:00:00.000Z", done: true }, NOW),
    ).toBe(false);
  });
  it("never fires without a reminder set", () => {
    expect(taskReminderDue({ reminder_at: null, done: false }, NOW)).toBe(
      false,
    );
  });
});

describe("parseMonthParam", () => {
  it("accepts YYYY-MM", () => {
    expect(parseMonthParam("2026-10")).toBe("2026-10");
  });
  it("rejects bad months", () => {
    expect(() => parseMonthParam("2026-13")).toThrow("month must be YYYY-MM");
    expect(() => parseMonthParam("october")).toThrow("month must be YYYY-MM");
  });
});

describe("parseDateParam", () => {
  it("accepts a real date", () => {
    expect(parseDateParam("2026-10-14")).toBe("2026-10-14");
  });
  it("rejects impossible dates", () => {
    expect(() => parseDateParam("2026-02-30")).toThrow(
      "date must be a real calendar date",
    );
    expect(() => parseDateParam("14-10-2026")).toThrow("date must be YYYY-MM-DD");
  });
});
