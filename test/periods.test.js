import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidPeriod,
  isoWeekKey,
  quarterOf,
  score,
  scoreIfTouched,
  shiftMonth,
  slotsForMonth,
  weeksInMonth,
} from "../src/periods.js";

test("shiftMonth crosses year boundaries", () => {
  assert.equal(shiftMonth("2026-11", 2), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-06", -18), "2024-12");
});

test("quarterOf", () => {
  assert.equal(quarterOf("2026-01"), "2026-Q1");
  assert.equal(quarterOf("2026-11"), "2026-Q4");
});

test("isoWeekKey matches known ISO weeks", () => {
  assert.equal(isoWeekKey(new Date(Date.UTC(2026, 10, 9))), "2026-W46"); // Mon Nov 9 2026
  assert.equal(isoWeekKey(new Date(Date.UTC(2021, 0, 3))), "2020-W53"); // Sun Jan 3 2021
  assert.equal(isoWeekKey(new Date(Date.UTC(2024, 11, 30))), "2025-W01"); // Mon Dec 30 2024
});

test("weeksInMonth lists the weeks whose Monday is in the month", () => {
  assert.deepEqual(
    weeksInMonth("2026-11").map((w) => w.start),
    ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]
  );
  assert.equal(weeksInMonth("2026-02").length, 4);
});

test("isValidPeriod per cadence", () => {
  assert.ok(isValidPeriod("monthly", "2026-11"));
  assert.ok(!isValidPeriod("monthly", "2026-13"));
  assert.ok(isValidPeriod("weekly", "2026-W46"));
  assert.ok(!isValidPeriod("weekly", "2025-W53")); // 2025 has 52 ISO weeks
  assert.ok(isValidPeriod("weekly", "2026-W53")); // Jan 1 2026 is a Thursday: 53 weeks
  assert.ok(isValidPeriod("weekly", "2020-W53"));
  assert.ok(isValidPeriod("quarterly", "2026-Q4"));
  assert.ok(!isValidPeriod("quarterly", "2026-Q5"));
  assert.ok(!isValidPeriod("monthly", "2026-W46"));
  assert.ok(!isValidPeriod("daily", "2026-11"));
});

test("score excludes N/A and treats unset as not yet", () => {
  const habits = [
    { id: "a", cadence: "monthly" },
    { id: "b", cadence: "quarterly" },
    { id: "c", cadence: "weekly" },
  ];
  const slots = slotsForMonth(habits, "2026-11");
  assert.equal(slots.length, 1 + 1 + 5);
  const m = new Map([
    ["a|2026-11", 2],
    ["b|2026-Q4", 3],
    ["c|2026-W45", 1],
  ]);
  // a=2/2, b excluded, c: 1 + 0*4 over 10 => 3/12
  assert.equal(score(slots, m), 3 / 12);
  assert.equal(score([], m), null);
  assert.equal(scoreIfTouched(slotsForMonth(habits, "2026-09"), m), null);
});
