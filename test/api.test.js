import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { _resetJwksCache } from "../src/auth.js";
import { makeDb } from "./fake-d1.js";
import { env, jwksFetch, makeSigner } from "./helpers.js";

let signer, token, db, e, deps;
before(async () => {
  signer = await makeSigner();
  token = await signer.sign({});
});
beforeEach(() => {
  _resetJwksCache();
  db = makeDb();
  e = env(db);
  deps = { fetch: jwksFetch([signer.jwk]) };
});

const BASE = "https://stluker.com";
function call(path, { method = "GET", body, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth) h["Cf-Access-Jwt-Assertion"] = token;
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (method !== "GET" && !("X-Grow-Client" in h)) h["X-Grow-Client"] = "1";
  return handle(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), e, deps);
}
const j = async (res) => [res.status, await res.json()];

// ---------------------------------------------------------------- routing & gate

test("www redirects to the apex, bare /grow to /grow/", async () => {
  const r1 = await handle(new Request("https://www.stluker.com/grow/x?y=1"), e, deps);
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.get("Location"), "https://stluker.com/grow/x?y=1");
  const r2 = await handle(new Request("https://stluker.com/grow"), e, deps);
  assert.equal(r2.headers.get("Location"), "https://stluker.com/grow/");
});

test("paths outside /grow are refused (route is exact)", async () => {
  assert.equal((await call("/growth")).status, 404);
  assert.equal((await call("/")).status, 404);
});

test("health is public; everything else needs auth, static files included", async () => {
  assert.equal((await call("/grow/health", { auth: false })).status, 200);
  assert.equal((await call("/grow/", { auth: false })).status, 401);
  assert.equal((await call("/grow/app.js", { auth: false })).status, 401);
  assert.equal((await call("/grow/api/month/2026-11", { auth: false })).status, 401);
});

test("authorized static request is served with security headers", async () => {
  const res = await call("/grow/");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "asset:/grow/");
  assert.match(res.headers.get("Content-Security-Policy"), /default-src 'self'/);
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});

test("unconfigured Worker fails closed", async () => {
  e = env(db, { ACCESS_AUD: "" });
  assert.equal((await call("/grow/")).status, 503);
});

// ---------------------------------------------------------------- data

test("seeded month view has 6 areas, 15 habits, empty score 0", async () => {
  const [s, d] = await j(await call("/grow/api/month/2026-11"));
  assert.equal(s, 200);
  assert.equal(d.areas.length, 6);
  assert.equal(d.areas.flatMap((a) => a.habits).length, 15);
  assert.equal(d.quarter, "2026-Q4");
  assert.equal(d.weeks.length, 5);
  assert.equal(d.score, 0);
  const r1 = d.areas.find((a) => a.id === "rest").habits[0];
  assert.equal(r1.periods.length, 5); // one pill per week
  assert.equal(d.areas.find((a) => a.id === "tools").habits[0].periods[0].key, "2026-Q4");
});

test("status write updates scores and trend", async () => {
  let [s] = await j(await call("/grow/api/status", { method: "PUT", body: { habitId: "h1", periodKey: "2026-11", status: 2 } }));
  assert.equal(s, 200);
  [s] = await j(await call("/grow/api/status", { method: "PUT", body: { habitId: "t1", periodKey: "2026-Q4", status: 3 } }));
  assert.equal(s, 200);
  const [, d] = await j(await call("/grow/api/month/2026-11"));
  const ship = d.areas.find((a) => a.id === "ship");
  assert.equal(ship.score, 0.5);
  assert.equal(d.areas.find((a) => a.id === "tools").habits[0].periods[0].status, 3);
  // monthly slots 10 + quarterly 2 (one N/A) + weekly 3x5 = 26 counted => 2/52
  assert.equal(d.score, 2 / 52);

  const [, t] = await j(await call("/grow/api/trend?end=2026-11&n=3"));
  assert.deepEqual(t.months.map((m) => m.month), ["2026-09", "2026-10", "2026-11"]);
  assert.equal(t.months[0].score, null);
  assert.equal(t.months[1].score, 0); // Oct shares Q4 with a recorded status
  assert.equal(t.months[2].score, 2 / 52);

  // overwrite is an upsert
  await call("/grow/api/status", { method: "PUT", body: { habitId: "h1", periodKey: "2026-11", status: 1 } });
  const [, d2] = await j(await call("/grow/api/month/2026-11"));
  assert.equal(d2.areas.find((a) => a.id === "ship").score, 0.25);
});

test("status validation", async () => {
  const put = (b) => call("/grow/api/status", { method: "PUT", body: b });
  assert.equal((await put({ habitId: "h1", periodKey: "2026-W46", status: 2 })).status, 400); // weekly key on monthly habit
  assert.equal((await put({ habitId: "r1", periodKey: "2026-11", status: 2 })).status, 400);
  assert.equal((await put({ habitId: "h1", periodKey: "2026-11", status: 4 })).status, 400);
  assert.equal((await put({ habitId: "h1", periodKey: "2026-11", status: "2" })).status, 400);
  assert.equal((await put({ habitId: "nope", periodKey: "2026-11", status: 2 })).status, 404);
  assert.equal((await put({ habitId: "r1", periodKey: "2026-W46", status: 2 })).status, 200);
});

test("reflections round-trip and are length-capped", async () => {
  let res = await call("/grow/api/reflection", { method: "PUT", body: { month: "2026-11", win: " Shipped a script ", miss: "" } });
  assert.equal(res.status, 200);
  const [, d] = await j(await call("/grow/api/month/2026-11"));
  assert.equal(d.reflection.win, "Shipped a script");
  res = await call("/grow/api/reflection", { method: "PUT", body: { month: "2026-11", win: "x".repeat(4001) } });
  assert.equal(res.status, 400);
  res = await call("/grow/api/reflection", { method: "PUT", body: { month: "2026-13", win: "" } });
  assert.equal(res.status, 400);
});

test("CSRF: writes need the client header and a same-origin Origin", async () => {
  const body = { habitId: "h1", periodKey: "2026-11", status: 2 };
  assert.equal((await call("/grow/api/status", { method: "PUT", body, headers: { "X-Grow-Client": "" } })).status, 403);
  assert.equal((await call("/grow/api/status", { method: "PUT", body, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/grow/api/status", { method: "PUT", body, headers: { Origin: "https://stluker.com" } })).status, 200);
});

test("non-JSON bodies are rejected", async () => {
  const res = await handle(
    new Request(`${BASE}/grow/api/status`, {
      method: "PUT",
      headers: { "Cf-Access-Jwt-Assertion": token, "X-Grow-Client": "1", "Content-Type": "text/plain" },
      body: "habitId=h1",
    }),
    e,
    deps
  );
  assert.equal(res.status, 415);
});

test("habits: add, reword, retire, restore; cadence is fixed", async () => {
  let [s, b] = await j(await call("/grow/api/habits", { method: "POST", body: { text: "Read a paper", areaId: "lead", cadence: "weekly" } }));
  assert.equal(s, 201);
  const id = b.id;
  assert.equal((await call("/grow/api/habits", { method: "POST", body: { text: "", areaId: "lead", cadence: "weekly" } })).status, 400);
  assert.equal((await call("/grow/api/habits", { method: "POST", body: { text: "x", areaId: "lead", cadence: "daily" } })).status, 400);
  assert.equal((await call("/grow/api/habits", { method: "POST", body: { text: "x", areaId: "nope", cadence: "weekly" } })).status, 400);

  assert.equal((await call(`/grow/api/habits/${id}`, { method: "PATCH", body: { text: "Read two papers" } })).status, 200);
  assert.equal((await call(`/grow/api/habits/${id}`, { method: "PATCH", body: { cadence: "monthly" } })).status, 400);
  assert.equal((await call(`/grow/api/habits/${id}`, { method: "PATCH", body: { active: "no" } })).status, 400);

  let [, d] = await j(await call("/grow/api/month/2026-11"));
  assert.ok(d.areas.find((a) => a.id === "lead").habits.some((h) => h.text === "Read two papers"));

  await call(`/grow/api/habits/${id}`, { method: "PATCH", body: { active: false } });
  [, d] = await j(await call("/grow/api/month/2026-11"));
  assert.ok(!d.areas.flatMap((a) => a.habits).some((h) => h.id === id));

  [s, b] = await j(await call("/grow/api/habits"));
  assert.equal(b.habits.find((h) => h.id === id).active, 0);
  await call(`/grow/api/habits/${id}`, { method: "PATCH", body: { active: true } });
  [, d] = await j(await call("/grow/api/month/2026-11"));
  assert.ok(d.areas.flatMap((a) => a.habits).some((h) => h.id === id));
});

test("export returns everything", async () => {
  await call("/grow/api/status", { method: "PUT", body: { habitId: "h1", periodKey: "2026-11", status: 2 } });
  const [s, d] = await j(await call("/grow/api/export"));
  assert.equal(s, 200);
  assert.equal(d.habits.length, 15);
  assert.equal(d.statuses.length, 1);
});

test("unknown API routes and bad params", async () => {
  assert.equal((await call("/grow/api/nope")).status, 404);
  assert.equal((await call("/grow/api/month/2026-13")).status, 400);
  assert.equal((await call("/grow/api/trend?end=bad")).status, 400);
  const [, t] = await j(await call("/grow/api/trend?end=2026-11&n=999"));
  assert.equal(t.months.length, 24);
});
