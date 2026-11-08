// Signs real RS256 Access-style JWTs and serves a fake JWKS, so the auth gate is
// exercised end to end without Cloudflare.
export const TEAM = "test-team.cloudflareaccess.com";
export const AUD = "aud-123";
export const EMAIL = "owner@example.com";

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export async function makeSigner(kid = "k1") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  async function sign(claims, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = enc({ alg: "RS256", kid, typ: "JWT", ...header });
    const p = enc({ aud: [AUD], iss: `https://${TEAM}`, email: EMAIL, iat: now, nbf: now, exp: now + 3600, ...claims });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
  }
  return { jwk, sign };
}

export function jwksFetch(keys, counter = { n: 0 }) {
  return async (url) => {
    counter.n++;
    if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify({ keys }), { headers: { "Content-Type": "application/json" } });
  };
}

export function env(db, extra = {}) {
  return {
    DB: db,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_EMAILS: `${EMAIL}, second@example.com`,
    ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`, { headers: { "Content-Type": "text/html" } }) },
    ...extra,
  };
}
