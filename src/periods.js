// Period keys and scoring. Pure functions, shared by the API and tests.
//   monthly   -> YYYY-MM
//   weekly    -> YYYY-Www (ISO week; a week belongs to the month its Monday is in)
//   quarterly -> YYYY-Qn

export const CADENCES = ["weekly", "monthly", "quarterly"];
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

export function isMonthKey(k) {
  return typeof k === "string" && MONTH_RE.test(k);
}

export function monthKeyOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(key, n) {
  const [y, m] = key.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function quarterOf(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this week decides the ISO year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Weeks whose Monday falls inside the month, oldest first.
export function weeksInMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const out = [];
  const d = new Date(Date.UTC(y, m - 1, 1));
  while ((d.getUTCDay() || 7) !== 1) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCMonth() === m - 1) {
    out.push({ key: isoWeekKey(d), start: d.toISOString().slice(0, 10) });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

export function isValidPeriod(cadence, key) {
  if (typeof key !== "string") return false;
  if (cadence === "monthly") return MONTH_RE.test(key);
  if (cadence === "quarterly") return QUARTER_RE.test(key);
  if (cadence === "weekly") {
    const m = WEEK_RE.exec(key);
    if (!m) return false;
    // Reject W53 in years that don't have one.
    if (m[2] === "53") return isoWeekKey(new Date(Date.UTC(Number(m[1]), 11, 28))) === key;
    return true;
  }
  return false;
}

// Every (habit, period) slot that counts toward a month.
export function slotsForMonth(habits, monthKey) {
  const weeks = weeksInMonth(monthKey).map((w) => w.key);
  const quarter = quarterOf(monthKey);
  const slots = [];
  for (const h of habits) {
    if (h.cadence === "monthly") slots.push({ habitId: h.id, periodKey: monthKey });
    else if (h.cadence === "quarterly") slots.push({ habitId: h.id, periodKey: quarter });
    else if (h.cadence === "weekly") for (const w of weeks) slots.push({ habitId: h.id, periodKey: w });
  }
  return slots;
}

export function periodKeysForMonth(monthKey) {
  return [monthKey, quarterOf(monthKey), ...weeksInMonth(monthKey).map((w) => w.key)];
}

// statusMap: Map("habitId|periodKey" -> 0..3). Unset counts as 0; 3 (N/A) is excluded.
// Returns a 0..1 fraction, or null when nothing counts.
export function score(slots, statusMap) {
  let got = 0;
  let max = 0;
  for (const s of slots) {
    const v = statusMap.get(`${s.habitId}|${s.periodKey}`) ?? 0;
    if (v === 3) continue;
    got += v;
    max += 2;
  }
  return max ? got / max : null;
}

// Score that ignores months with no recorded check-ins at all (used for the trend).
export function scoreIfTouched(slots, statusMap) {
  const touched = slots.some((s) => statusMap.has(`${s.habitId}|${s.periodKey}`));
  return touched ? score(slots, statusMap) : null;
}
