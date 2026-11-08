# stl-grow

Personal improvement tracker at **https://stluker.com/grow**.

| | |
|---|---|
| Worker | `stl-grow` |
| Routes | `stluker.com/grow`, `stluker.com/grow/*` (+ the same on `www`, which 301s to the apex) |
| D1 | `grow-db`, id `919cdb61-9b62-44d3-8186-cbc196bacefc` (created Nov 8, 2026, ENAM) |
| Deploy | GitHub Actions on push to `master`: test → `d1 migrations apply --remote` → `wrangler deploy` → smoke test |
| Auth | Cloudflare Access (path app on `stluker.com/grow`) **and** the Worker re-verifies the Access JWT (`src/auth.js`), deny by default. Only `/grow/health` is public |
| Main site | Untouched. Zone routes take precedence over the `stluker` Worker's custom domain for these paths only |

## Layout

```
src/index.js      router, API, security headers
src/auth.js       Access JWT verification (RS256 via JWKS), email allowlist, fails closed
src/periods.js    week/month/quarter keys and scoring (pure)
migrations/       0001 schema, 0002 seed (the 15 starting habits)
public/grow/      UI (no inline script/style; strict CSP)
test/             node:test against real SQLite (node:sqlite) and real signed JWTs
scripts/preview.mjs  local signed-in UI preview (dev only, never deployed)
```

## Local work

```
npm install
npm test                 # 30 tests
node scripts/preview.mjs # http://127.0.0.1:8790/grow/ (fake sign-in, in-memory DB)
```

## First-time setup (in this order)

Every step is safe to stop after: until step 5 the Worker answers **503** to everything except `/grow/health`.

**1. Repo.** `pdluker/stl-grow`, private, deploy branch `master`.

**2. CI token.** Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token:
- Name: `stl-grow CI`
- Permissions: Account · **Workers Scripts · Edit**; Account · **D1 · Edit**; Zone · **Workers Routes · Edit**
- Account resources: Include · your account. Zone resources: Include · Specific zone · `stluker.com`

**3. Repo secrets** (each command prompts for the value with hidden input; nothing goes in chat or history):
```
gh secret set CLOUDFLARE_API_TOKEN --repo pdluker/stl-grow
gh secret set CLOUDFLARE_ACCOUNT_ID --repo pdluker/stl-grow
```
The account ID is on the Workers & Pages overview page (right sidebar).

**4. First deploy.** GitHub → Actions → `test-migrate-deploy` → Run workflow (branch `master`).
Expected: migrations `0001_init.sql`, `0002_seed.sql` applied; deploy lists the 4 routes; smoke test prints `health=200 app(unauthenticated)=503`.

**5. Access app.** Zero Trust → Access → Applications → Add → Self-hosted:
- Name: `Grow`
- Public hostnames: `stluker.com` path `grow`, and `www.stluker.com` path `grow`
- Policy: Allow · Include · Emails · your Google address
- Session duration: 24 hours
- Save, then copy the app's **Audience (AUD) tag**. Your team domain is under Zero Trust → Settings (`<team>.cloudflareaccess.com`).

**6. Worker secrets** (hidden prompts):
```
npx wrangler secret put ACCESS_TEAM_DOMAIN --name stl-grow   # e.g. myteam.cloudflareaccess.com (no https://)
npx wrangler secret put ACCESS_AUD --name stl-grow           # the AUD tag from step 5
npx wrangler secret put ALLOWED_EMAILS --name stl-grow       # your Google address; comma-separate to add more
```

**7. Check.** Open https://stluker.com/grow in a private window: Access login → Google → the tracker. Without signing in, `/grow/` must redirect to `*.cloudflareaccess.com`.

## API (all under `/grow/api`, Access-authenticated)

| Method | Path | |
|---|---|---|
| GET | `/month/YYYY-MM` | areas, habits with their period pills, scores, reflection |
| GET | `/trend?end=YYYY-MM&n=6` | monthly scores (max 24) |
| PUT | `/status` | `{habitId, periodKey, status}`; status 0 not yet, 1 partial, 2 done, 3 N/A |
| PUT | `/reflection` | `{month, win, miss}` |
| GET/POST | `/habits` | list all / add `{text, areaId, cadence}` |
| PATCH | `/habits/:id` | `{text?, active?, areaId?}` (cadence is fixed) |
| GET | `/export` | full JSON backup |

Writes require `Content-Type: application/json`, header `X-Grow-Client: 1`, and a same-origin `Origin` when sent (CSRF).

## Scoring

Each slot scores Not yet 0, Partial 1, Done 2; N/A is left out. A month counts its monthly habits, the quarter's quarterly habits, and every week whose Monday falls in the month. Score = points / (2 × counted slots). The trend shows months with at least one recorded check-in.
