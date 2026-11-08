// Deny-by-default gate (Vault §7 rule 4).
// Cloudflare Access sits in front of /grow; this module re-verifies the Access JWT
// so the Worker is safe even if the Access app is misconfigured or removed.

export const PUBLIC_PATHS = new Set(["/grow/health"]);

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache = { team: null, at: 0, keys: [] };

export function _resetJwksCache() {
  jwksCache = { team: null, at: 0, keys: [] };
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

async function getKeys(team, fetchImpl, force) {
  const fresh = jwksCache.team === team && Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = await res.json();
  jwksCache = { team, at: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
  return jwksCache.keys;
}

export function allowedEmails(env) {
  return String(env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isConfigured(env) {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && allowedEmails(env).length);
}

// Returns { ok: true, email } or { ok: false, status, reason }.
export async function verifyAccess(request, env, fetchImpl = fetch) {
  if (!isConfigured(env)) return { ok: false, status: 503, reason: "auth not configured" };

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, reason: "missing access token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, reason: "malformed token" };

  let header, claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return { ok: false, status: 401, reason: "malformed token" };
  }
  if (header.alg !== "RS256" || !header.kid) return { ok: false, status: 401, reason: "bad algorithm" };

  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let jwk;
  try {
    let keys = await getKeys(team, fetchImpl, false);
    jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await getKeys(team, fetchImpl, true); // key rotation
      jwk = keys.find((k) => k.kid === header.kid);
    }
  } catch {
    return { ok: false, status: 503, reason: "cannot load signing keys" };
  }
  if (!jwk) return { ok: false, status: 401, reason: "unknown signing key" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, reason: "bad signature" };

  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return { ok: false, status: 401, reason: "wrong audience" };
  if (claims.iss !== `https://${team}`) return { ok: false, status: 401, reason: "wrong issuer" };
  if (typeof claims.exp !== "number" || claims.exp + skew < now) return { ok: false, status: 401, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) return { ok: false, status: 401, reason: "not yet valid" };

  const email = String(claims.email || "").toLowerCase();
  if (!email || !allowedEmails(env).includes(email)) return { ok: false, status: 403, reason: "not allowed" };

  return { ok: true, email };
}
