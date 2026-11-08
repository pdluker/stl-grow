import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifyAccess, _resetJwksCache } from "../src/auth.js";
import { AUD, EMAIL, TEAM, env, jwksFetch, makeSigner } from "./helpers.js";

const req = (token) =>
  new Request("https://stluker.com/grow/", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

let signer;
beforeEach(async () => {
  _resetJwksCache();
  signer ??= await makeSigner();
});

test("valid token for an allowed email passes", async () => {
  const r = await verifyAccess(req(await signer.sign({})), env(null), jwksFetch([signer.jwk]));
  assert.deepEqual(r, { ok: true, email: EMAIL });
});

test("email match is case-insensitive", async () => {
  const r = await verifyAccess(req(await signer.sign({ email: "Owner@Example.com" })), env(null), jwksFetch([signer.jwk]));
  assert.equal(r.ok, true);
});

test("fails closed when not configured", async () => {
  for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ALLOWED_EMAILS"]) {
    const r = await verifyAccess(req(await signer.sign({})), env(null, { [missing]: "" }), jwksFetch([signer.jwk]));
    assert.equal(r.status, 503, missing);
  }
});

test("rejects missing, malformed and tampered tokens", async () => {
  const f = jwksFetch([signer.jwk]);
  assert.equal((await verifyAccess(req(null), env(null), f)).status, 401);
  assert.equal((await verifyAccess(req("a.b"), env(null), f)).status, 401);
  assert.equal((await verifyAccess(req("x.y.z"), env(null), f)).status, 401);
  const good = await signer.sign({});
  const [h, , s] = good.split(".");
  const forged = Buffer.from(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: EMAIL, exp: 9999999999 })).toString("base64url");
  assert.equal((await verifyAccess(req(`${h}.${forged}.${s}`), env(null), f)).reason, "bad signature");
});

test("rejects a token signed by another key", async () => {
  const other = await makeSigner("k1"); // same kid, different key
  const r = await verifyAccess(req(await other.sign({})), env(null), jwksFetch([signer.jwk]));
  assert.equal(r.reason, "bad signature");
});

test("rejects alg other than RS256 (incl. none)", async () => {
  const r = await verifyAccess(req(await signer.sign({}, { alg: "none" })), env(null), jwksFetch([signer.jwk]));
  assert.equal(r.reason, "bad algorithm");
});

test("checks audience, issuer, expiry, nbf", async () => {
  const f = jwksFetch([signer.jwk]);
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await verifyAccess(req(await signer.sign({ aud: ["other"] })), env(null), f)).reason, "wrong audience");
  assert.equal((await verifyAccess(req(await signer.sign({ iss: "https://evil.cloudflareaccess.com" })), env(null), f)).reason, "wrong issuer");
  assert.equal((await verifyAccess(req(await signer.sign({ exp: now - 120 })), env(null), f)).reason, "expired");
  assert.equal((await verifyAccess(req(await signer.sign({ nbf: now + 600 })), env(null), f)).reason, "not yet valid");
});

test("allowed list is enforced (403, not 401)", async () => {
  const r = await verifyAccess(req(await signer.sign({ email: "stranger@example.com" })), env(null), jwksFetch([signer.jwk]));
  assert.equal(r.status, 403);
});

test("JWKS is cached and refetched once on an unknown kid", async () => {
  const counter = { n: 0 };
  const f = jwksFetch([signer.jwk], counter);
  await verifyAccess(req(await signer.sign({})), env(null), f);
  await verifyAccess(req(await signer.sign({})), env(null), f);
  assert.equal(counter.n, 1);
  const rotated = await makeSigner("k2");
  const r = await verifyAccess(req(await rotated.sign({})), env(null), f);
  assert.equal(r.reason, "unknown signing key");
  assert.equal(counter.n, 2);
});

test("JWKS outage fails closed with 503", async () => {
  const r = await verifyAccess(req(await signer.sign({})), env(null), async () => new Response("down", { status: 500 }));
  assert.equal(r.status, 503);
});
