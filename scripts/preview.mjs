// Local UI preview: runs the real Worker handler with SQLite and a self-signed
// Access token injected on every request. Dev only; never deployed (scripts/ is
// outside the assets directory and not imported by src/).
//   node scripts/preview.mjs  ->  http://127.0.0.1:8790/grow/
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { handle } from "../src/index.js";
import { makeDb } from "../test/fake-d1.js";
import { env, jwksFetch, makeSigner } from "../test/helpers.js";

const PORT = Number(process.env.PORT || 8790);
const root = join(import.meta.dirname, "..", "public");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

const signer = await makeSigner();
const db = makeDb();
const e = env(db, {
  ASSETS: {
    async fetch(req) {
      let p = new URL(req.url).pathname;
      if (p.endsWith("/")) p += "index.html";
      try {
        return new Response(await readFile(join(root, p)), { headers: { "Content-Type": types[extname(p)] || "application/octet-stream" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  },
});
const deps = { fetch: jwksFetch([signer.jwk]) };

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers(req.headers);
  headers.set("Cf-Access-Jwt-Assertion", await signer.sign({}));
  const url = `https://stluker.com${req.url}`;
  // Same-origin check: the browser sends http://127.0.0.1 as Origin; map it.
  if (headers.get("origin")) headers.set("origin", "https://stluker.com");
  const r = await handle(
    new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }),
    e,
    deps
  );
  const out = {};
  r.headers.forEach((v, k) => (out[k] = k === "location" ? v.replace("https://stluker.com", "") : v));
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.log(`preview on http://127.0.0.1:${PORT}/grow/`));
