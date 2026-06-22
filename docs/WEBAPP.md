# ExileAutoPath — Web App Design

Goal: a hosted page where a player **pastes a Path of Building 2 code or uploads a
`.txt`/`.pob` file** (and later, **connects their GGG account**) and gets the full
report back in the browser — closest meta builds, the path toward #1, and a
survivability breakdown.

Status: design. The backend logic already exists as importable modules; the web
app is a thin layer over them.

---

## 1. Key insight — the backend is already written

Everything the report needs is in `src/` and is pure/Node-callable:

```
decodePobCode / parsePobXml   (ingest/pobcode)
pobBuildToBuildSpec           (ingest/buildspec)
computeStatsFromXml           (engine/pob)        ← LuaJIT subprocess
matchBuilds                   (match/matcher)     ← against a cached corpus
planPath                      (plan/planner)
analyzeSurvival               (report/survival)
renderPlanHtml                (report/html)       ← already emits a full page
```

So the MVP server is essentially: **receive a code → run the same pipeline the
`plan` CLL command runs → return JSON (or the rendered HTML).** No new domain
logic. The corpus is built offline (Playwright) and cached as JSON; web requests
never scrape.

---

## 2. UX

```
┌──────────────────────────────────────────────────────────┐
│  ExileAutoPath            Runes of Aldur ▾                 │
│                                                            │
│  Analyze your build                                        │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Paste your Path of Building 2 code…               │    │
│  │                                                    │    │
│  └──────────────────────────────────────────────────┘    │
│   …or  [ Upload .txt / .pob ]      [ Analyze ▸ ]          │
│                                                            │
│   [ Connect GGG account ]  (import your character)  ·beta  │
└──────────────────────────────────────────────────────────┘
        │  POST /api/analyze
        ▼
┌──────────────────────────────────────────────────────────┐
│  Sorceress (Stormweaver) / Twister — L47                  │
│  ── Stats ──────────────────────────────────────────────  │
│   DPS · Life · ES · Spirit · Armour · res (red if uncapped)│
│  ── Closest builds ─────────────────────────────────────  │
│   #1 60%  Spirit Walker / Twister   [guide ↗]              │
│   #2 57%  …                                                │
│  ── Path to #1 ─────────────────────────────────────────  │
│   1. acquire skills…  2. buy uniques…  3. re-spec ~67     │
│  ── Survivability ──────────────────────────────────────  │
│   ✗ Fire res 30/75   ✗ eHP low   ! Spirit 100% reserved   │
└──────────────────────────────────────────────────────────┘
```

How to get a PoB2 code (shown as inline help): in Path of Building 2 →
Import/Export → Generate/Copy; or paste a pobb.in/poe.ninja/mobalytics build's code.

---

## 3. Architecture

```
 Browser (SPA or 1 page)
   │  paste code / upload file              ┌──────────────────────────────┐
   ├── POST /api/analyze {code|xml} ───────▶│  Node backend (Fastify)        │
   │                                        │   • decode+parse               │
   │                                        │   • computeStats ── spawn ────▶ LuaJIT + .vendor/PoB-PoE2
   │                                        │   • matchBuilds(corpus.json)   │   (worker pool, per-req)
   │                                        │   • planPath + analyzeSurvival │
   │◀── JSON { user, stats, matches, ───────│   • (renderPlanHtml for share) │
   │         path, guide }                  └──────────────────────────────┘
   │  render in UI                                   ▲
   │                                                 │ reads
 [ Connect GGG account ] ── OAuth (§5) ──┐    data/corpus-<league>.json
                                          ▼          ▲ writes (offline)
                              api.pathofexile.com    │
                                                 corpus refresh job (cron):
                                                 `cli corpus` via Playwright
```

**Backend** — Node + **Fastify** (light, fast, good for a JSON API). Endpoints:

| Method | Path | Body / params | Returns |
|---|---|---|---|
| `POST` | `/api/analyze` | `{ code }` or `{ xml }`, optional `{ league }` | `{ user, stats, matches[3], path, guide }` |
| `GET` | `/api/leagues` | — | available corpora (league → build count, built-at) |
| `GET` | `/api/health` | — | engine + corpus readiness |
| `GET` | `/r/:id` | — | (optional) shareable saved report |
| OAuth | `/auth/ggg/*` | see §5 | character import (phase 2) |

`/api/analyze` is literally the `plan` command's body refactored into a function
`analyze(input, corpus, opts) → ReportData` shared by CLI and server (extract it
from `cli.ts` into `src/app/analyze.ts` so both call it). Return JSON; the frontend
renders it (reusing the `report/html.ts` look as components), and `renderPlanHtml`
stays available for a "download/share report" button.

**Frontend** — start minimal: one static page + vanilla TS (or a small React/Vite
app) that POSTs and renders the JSON. The existing `renderPlanHtml` markup is the
visual spec; port its sections to components, or for a true MVP just have the server
return the rendered HTML fragment and inject it.

---

## 4. Engine & corpus on the server (the operational core)

- **Engine = LuaJIT subprocess** (same as CLI). The server needs LuaJIT + the
  vendored `PathOfBuilding-PoE2/` on disk. Each `computeStatsFromXml` spawns a
  process (~1s). Protect with: a **concurrency-limited worker pool** (e.g. 2–4),
  a per-call **timeout**, stdin closed (already), and **no outbound network** from
  the Lua process. Optionally keep a warm LuaJIT process pool later for latency.
- **Corpus is pre-built, not scraped per request.** A scheduled job runs
  `cli corpus --source mobalytics --league <slug>` (Playwright/Chromium) on a
  cadence (e.g. daily) and writes `data/corpus-<league>.json`. The API loads/caches
  these in memory and hot-swaps on refresh. Browser requests never touch Playwright.
- **Packaging = a container** (not serverless): the image bundles Node, **LuaJIT**,
  the **PoB-PoE2 checkout**, and (for the corpus job) **Chromium**. Serverless is a
  poor fit (native binary + large checkout + headless browser + ~1s CPU bursts).
  Run on a small VPS / container host. The corpus job can be a separate container or
  a cron sidecar so the web tier stays light.

---

## 5. GGG account import (OAuth) — phase 2

Re-verified 2026-06-22 (see [[poe2-character-import-oauth]]). PoE2 characters are
**only** reachable via GGG's OAuth API — not on website profiles, not via POESESSID.
poe.ninja shipped exactly this ("Add your character", Apr 2025), so the flow is
proven in production.

- **A hosted web app is a CONFIDENTIAL client.** Authorization Code + PKCE, with a
  `client_secret` kept server-side. Tokens: **access 28 days, refresh 90 days**.
  Redirect URI must be **HTTPS on your registered domain** (no localhost/IP).
- **Flow:** backend makes `code_verifier`/`code_challenge` (S256) + `state` →
  redirect to `https://www.pathofexile.com/oauth/authorize?client_id=…&response_type=code&scope=account:characters&state=…&redirect_uri=https://…/auth/ggg/callback&code_challenge=…&code_challenge_method=S256`
  → on callback verify `state`, POST `/oauth/token` within **30 s** (code expiry) with
  the secret + verifier → store tokens **encrypted, server-side, per user**.
- **Fetch:** `GET https://api.pathofexile.com/character/poe2` (list) then
  `/character/poe2/<name>`; header `Authorization: Bearer …` + required
  `User-Agent: OAuth <clientId>/<ver> (contact: <email>)`; honor `X-Rate-Limit-*` /
  `Retry-After`. Map the returned JSON (`passives.hashes`,
  `passives.specialisations.set1/2/3`, `equipment[]`, `skills[]`) → PoB2 build →
  same analyze pipeline. (This is the `ingest/charjson` converter on the roadmap.)
- **The blocker:** client registration is **manual** (email `oauth@grindinggear.com`,
  no portal, no sandbox, *"low-effort / LLM-generated requests immediately rejected"*).
  Request only `account:characters`, justify it, include the account name (with
  `#1234`) + HTTPS redirect, and the *"not affiliated with GGG"* disclaimer in the app.
- **Consent model:** the user clicks "Connect GGG account", consents on GGG's page,
  and we import only *their* character. No public profile, no scraping. Provide a
  disconnect (delete/`revoke` tokens) and a short privacy policy.

Until a client is approved, **paste/upload is the shipping path** and needs no
approval — so the web app launches without OAuth and gains it later.

---

## 6. Build plan (phased)

- **W1 — extract `analyze()`** ✅ `src/app/analyze.ts` (async; shared by the `plan`
  CLI and the server). Uses the async engine (`computeStatsFromXmlAsync`).
- **W2 — Fastify server** ✅ `src/server/server.ts` (`npm run serve`): `POST
  /api/analyze` (returns the rendered report HTML), `GET /api/health`, `/api/leagues`.
  In-memory corpus cache from `data/corpus*.json`; engine async + concurrency-capped
  (MAX_INFLIGHT); 4 MB body limit. Static frontend `public/index.html`.
- **W3 — file upload** ✅ (`.txt`/`.pob` → textarea) + paste + league selector in the
  page. *Remaining:* "download report" button, shareable saved reports (optional).
- **W3.5 — interactive passive tree** ✅ A pannable/zoomable SVG of the full PoE2
  tree: your allocated nodes in gold, the #1 match's additions in green, keystones/
  notables sized up. Tree data is converted once from PoB's `tree.lua` →
  `public/tree-<ver>.json` (`scripts/tree_to_json.lua`, run via `npm run build:tree`)
  with precomputed positions (group + `orbitRadii` + `orbitAnglesByOrbit`) and edges.
  `/api/analyze` returns `tree.{userNodes,targetNodes}`; the page fetches the tree
  JSON once and renders. Makes the "path" visual.
- **W4 — corpus refresh job** (scheduled `cli corpus`), multi-league corpora,
  container image (Node + LuaJIT + PoB checkout + Chromium), deploy.
- **W5 — OAuth import** once a confidential client is approved: `/auth/ggg/*`,
  token store, `charjson → PoB2` converter, "Connect GGG account" button.

---

## 7. Risks / decisions

- **Hosting** must allow native LuaJIT + a bundled browser → container/VPS, not
  serverless. (Decision needed at W4: which host.)
- **Engine latency** ~1s/req; worker pool + timeouts keep it bounded. Warm-process
  pool is a later optimization.
- **Don't log user build codes** (treat as user data). Tokens encrypted at rest.
- **Frontend stack** (vanilla vs React/Vite) — start vanilla/minimal; adopt a
  framework only if the UI grows. (Decision deferred to W2.)
- **OAuth registration** is external and slow — keep it strictly off the critical
  path; paste/upload ships first.
