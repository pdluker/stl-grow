// stl-grow Worker: https://stluker.com/grow
import { PUBLIC_PATHS, verifyAccess } from "./auth.js";
import {
  CADENCES,
  isMonthKey,
  isValidPeriod,
  monthKeyOf,
  periodKeysForMonth,
  quarterOf,
  score,
  scoreIfTouched,
  shiftMonth,
  slotsForMonth,
  weeksInMonth,
} from "./periods.js";

const BASE = "/grow";
const CANONICAL_HOST = "stluker.com";
const MAX_TEXT = 200;
const MAX_REFLECTION = 4000;
const MAX_TREND = 24;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);

  if (url.hostname === `www.${CANONICAL_HOST}`) {
    return Response.redirect(`https://${CANONICAL_HOST}${url.pathname}${url.search}`, 301);
  }
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) {
    return text("Not found", 404);
  }
  if (url.pathname === BASE) {
    return Response.redirect(`${url.origin}${BASE}/`, 301);
  }
  if (PUBLIC_PATHS.has(url.pathname)) {
    return json({ ok: true, service: "stl-grow" });
  }

  const auth = await verifyAccess(request, env, deps.fetch);
  if (!auth.ok) return text(auth.status === 503 ? "Service unavailable" : "Unauthorized", auth.status);

  if (url.pathname.startsWith(`${BASE}/api/`)) {
    try {
      return await api(request, env, url, auth);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("api error", err && err.stack);
      return json({ error: "internal error" }, 500);
    }
  }

  const res = await env.ASSETS.fetch(request);
  return withHeaders(res, { ...SECURITY_HEADERS, "Cache-Control": "no-store" });
}

// ---------------------------------------------------------------- API

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(request, env, url, auth) {
  const route = url.pathname.slice(`${BASE}/api`.length);
  const method = request.method;

  if (method !== "GET" && method !== "HEAD") assertSameOrigin(request, url);

  if (method === "GET" && route === "/me") return json({ email: auth.email });

  let m;
  if (method === "GET" && (m = route.match(/^\/month\/(\d{4}-\d{2})$/))) {
    return json(await getMonth(env.DB, m[1]));
  }
  if (method === "GET" && route === "/trend") {
    const end = url.searchParams.get("end") || monthKeyOf(new Date());
    const n = Math.min(MAX_TREND, Math.max(1, Number(url.searchParams.get("n")) || 6));
    if (!isMonthKey(end)) throw new HttpError(400, "bad end month");
    return json(await getTrend(env.DB, end, n));
  }
  if (method === "PUT" && route === "/status") return json(await putStatus(env.DB, await body(request)));
  if (method === "PUT" && route === "/reflection") return json(await putReflection(env.DB, await body(request)));
  if (method === "GET" && route === "/habits") return json(await listHabits(env.DB));
  if (method === "POST" && route === "/habits") return json(await createHabit(env.DB, await body(request)), 201);
  if (method === "PATCH" && (m = route.match(/^\/habits\/([a-z0-9-]{1,40})$/))) {
    return json(await updateHabit(env.DB, m[1], await body(request)));
  }
  if (method === "GET" && route === "/export") return json(await exportAll(env.DB));

  throw new HttpError(404, "no such endpoint");
}

// CSRF: state changes need our custom header (forces a CORS preflight cross-site)
// and, when the browser sends one, a same-origin Origin.
function assertSameOrigin(request, url) {
  if (request.headers.get("X-Grow-Client") !== "1") throw new HttpError(403, "missing client header");
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "cross-origin request");
}

async function body(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "expected JSON");
  try {
    const b = await request.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

async function activeHabits(db) {
  const { results } = await db
    .prepare("SELECT id, area_id, text, cadence, sort FROM habits WHERE active = 1 ORDER BY area_id, sort, id")
    .all();
  return results;
}

async function statusMapFor(db, keys) {
  const map = new Map();
  if (!keys.length) return map;
  const qs = keys.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT habit_id, period_key, status FROM statuses WHERE period_key IN (${qs})`)
    .bind(...keys)
    .all();
  for (const r of results) map.set(`${r.habit_id}|${r.period_key}`, r.status);
  return map;
}

export async function getMonth(db, month) {
  if (!isMonthKey(month)) throw new HttpError(400, "bad month");
  const [areasRes, habits, reflection] = await Promise.all([
    db.prepare("SELECT id, name, roast, sort FROM areas ORDER BY sort, id").all(),
    activeHabits(db),
    db.prepare("SELECT win, miss, updated_at FROM reflections WHERE month_key = ?").bind(month).first(),
  ]);
  const statusMap = await statusMapFor(db, periodKeysForMonth(month));
  const weeks = weeksInMonth(month);
  const quarter = quarterOf(month);

  const areas = areasRes.results.map((a) => {
    const list = habits.filter((h) => h.area_id === a.id);
    return {
      id: a.id,
      name: a.name,
      roast: a.roast,
      score: score(slotsForMonth(list, month), statusMap),
      habits: list.map((h) => {
        const periods =
          h.cadence === "weekly"
            ? weeks.map((w) => ({ key: w.key, label: w.start.slice(5) }))
            : [{ key: h.cadence === "quarterly" ? quarter : month, label: h.cadence === "quarterly" ? quarter.slice(5) : "" }];
        return {
          id: h.id,
          text: h.text,
          cadence: h.cadence,
          periods: periods.map((p) => ({ ...p, status: statusMap.get(`${h.id}|${p.key}`) ?? 0 })),
        };
      }),
    };
  });

  return {
    month,
    quarter,
    weeks,
    score: score(slotsForMonth(habits, month), statusMap),
    areas: areas.filter((a) => a.habits.length),
    reflection: reflection || { win: "", miss: "", updated_at: null },
  };
}

export async function getTrend(db, end, n) {
  const months = [];
  for (let i = n - 1; i >= 0; i--) months.push(shiftMonth(end, -i));
  const habits = await activeHabits(db);
  const keys = [...new Set(months.flatMap(periodKeysForMonth))];
  const statusMap = await statusMapFor(db, keys);
  return { months: months.map((m) => ({ month: m, score: scoreIfTouched(slotsForMonth(habits, m), statusMap) })) };
}

export async function putStatus(db, b) {
  const { habitId, periodKey, status } = b;
  if (typeof habitId !== "string") throw new HttpError(400, "habitId required");
  if (!Number.isInteger(status) || status < 0 || status > 3) throw new HttpError(400, "status must be 0-3");
  const habit = await db.prepare("SELECT id, cadence FROM habits WHERE id = ?").bind(habitId).first();
  if (!habit) throw new HttpError(404, "no such habit");
  if (!isValidPeriod(habit.cadence, periodKey)) throw new HttpError(400, `bad period for a ${habit.cadence} habit`);
  await db
    .prepare(
      `INSERT INTO statuses (habit_id, period_key, status, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (habit_id, period_key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
    )
    .bind(habitId, periodKey, status)
    .run();
  return { ok: true, habitId, periodKey, status };
}

export async function putReflection(db, b) {
  const { month } = b;
  if (!isMonthKey(month)) throw new HttpError(400, "bad month");
  const win = cleanText(b.win, MAX_REFLECTION, "win");
  const miss = cleanText(b.miss, MAX_REFLECTION, "miss");
  await db
    .prepare(
      `INSERT INTO reflections (month_key, win, miss, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (month_key) DO UPDATE SET win = excluded.win, miss = excluded.miss, updated_at = excluded.updated_at`
    )
    .bind(month, win, miss)
    .run();
  return { ok: true, month };
}

export async function listHabits(db) {
  const [areas, habits] = await Promise.all([
    db.prepare("SELECT id, name, roast, sort FROM areas ORDER BY sort, id").all(),
    db.prepare("SELECT id, area_id, text, cadence, sort, active FROM habits ORDER BY area_id, sort, id").all(),
  ]);
  return { areas: areas.results, habits: habits.results, cadences: CADENCES };
}

export async function createHabit(db, b) {
  const text = cleanText(b.text, MAX_TEXT, "text", true);
  const cadence = b.cadence;
  if (!CADENCES.includes(cadence)) throw new HttpError(400, "bad cadence");
  const area = await db.prepare("SELECT id FROM areas WHERE id = ?").bind(b.areaId).first();
  if (!area) throw new HttpError(400, "no such area");
  const id = `x${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const next = await db
    .prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM habits WHERE area_id = ?")
    .bind(area.id)
    .first();
  await db
    .prepare("INSERT INTO habits (id, area_id, text, cadence, sort) VALUES (?, ?, ?, ?, ?)")
    .bind(id, area.id, text, cadence, next.s)
    .run();
  return { ok: true, id };
}

// Changing a habit's cadence would orphan its old check-ins under the wrong key
// type, so cadence is fixed once set: retire the habit and add a new one instead.
export async function updateHabit(db, id, b) {
  const habit = await db.prepare("SELECT id FROM habits WHERE id = ?").bind(id).first();
  if (!habit) throw new HttpError(404, "no such habit");
  if ("cadence" in b) throw new HttpError(400, "cadence can't change; retire this habit and add a new one");
  const sets = [];
  const vals = [];
  if ("text" in b) {
    sets.push("text = ?");
    vals.push(cleanText(b.text, MAX_TEXT, "text", true));
  }
  if ("active" in b) {
    if (typeof b.active !== "boolean") throw new HttpError(400, "active must be true or false");
    sets.push("active = ?");
    vals.push(b.active ? 1 : 0);
  }
  if ("areaId" in b) {
    const area = await db.prepare("SELECT id FROM areas WHERE id = ?").bind(b.areaId).first();
    if (!area) throw new HttpError(400, "no such area");
    sets.push("area_id = ?");
    vals.push(area.id);
  }
  if (!sets.length) throw new HttpError(400, "nothing to update");
  await db.prepare(`UPDATE habits SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  return { ok: true, id };
}

export async function exportAll(db) {
  const [areas, habits, statuses, reflections] = await Promise.all([
    db.prepare("SELECT * FROM areas ORDER BY sort").all(),
    db.prepare("SELECT * FROM habits ORDER BY area_id, sort").all(),
    db.prepare("SELECT * FROM statuses ORDER BY period_key, habit_id").all(),
    db.prepare("SELECT * FROM reflections ORDER BY month_key").all(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    areas: areas.results,
    habits: habits.results,
    statuses: statuses.results,
    reflections: reflections.results,
  };
}

// ---------------------------------------------------------------- helpers

function cleanText(v, max, field, required = false) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  const s = v.replace(/\r\n/g, "\n").trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

function text(msg, status) {
  return new Response(msg, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
