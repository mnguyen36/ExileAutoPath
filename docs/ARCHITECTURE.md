# ExileAutoPath — Architecture & Plan

Living spec. It is expected to change as the engine spike and scrapers teach us
the real shapes. Last substantive update: 2026-06-21 (initial scaffold).

---

## 1. Goal

Let a PoE2 player import their current character and get back:

1. **The closest real build** to what they're already playing.
2. **A path to that build's final form** — passive nodes to allocate, gems to
   acquire, items to buy/upgrade — ordered into achievable steps with rough cost.
3. **A survival guide** — which stats are weak (uncapped resistances, low eHP for
   the content, over-reserved spirit, missing defensive layer) and the single most
   impactful next upgrade.

Focus league: **Runes of Aldur** (patch 0.5.0). League is a parameter throughout —
poe.ninja already treats `runesofaldur` as a past slug, so don't hardcode it.

---

## 2. Key constraints discovered (the research that shapes the design)

These are load-bearing. Full detail lives in the project memory notes.

1. **Don't reimplement stats — embed Path of Building 2.**
   `PathOfBuildingCommunity/PathOfBuilding-PoE2` (Lua/LuaJIT, v0.21) runs headless
   (`src/HeadlessWrapper.lua` → load build → read flat `output` table with
   `TotalDPS`, `Life`, `EnergyShield`, `Spirit`, resistances, `Armour`, per-damage
   `*MaximumHitTaken`). There's a WASM port (`atty303/pob-web`) that runs the same
   Lua under Node/browser. **We embed; we never re-derive the math.**

2. **PoE2 character import is OAuth-only, and registration is a wall.**
   Only GGG's OAuth API serves PoE2 characters: `GET /character/poe2/<name>`,
   scope `account:characters`, PKCE public client. The legacy POESESSID
   `character-window/*` endpoints are PoE1-only; PoE2 chars aren't on website
   profiles; **Steam is not a data source** (it's just a login link to the GGG
   account). OAuth client registration is manual via `oauth@grindinggear.com` and
   *"low-effort or LLM-generated requests are immediately rejected."*
   → **MVP ingests pasted PoB2 codes / character JSON. OAuth is a parallel track.**

3. **Two complementary build corpora.**
   - **poe.ninja** `/poe2/builds/{leagueSlug}` — ladder snapshots (what's played).
     Undocumented per-league snapshot API: `GET /poe2/api/builds/{version}/search`,
     `/tooltip`, `/dictionary/{hash}`. Responses are **protobuf** with hash-keyed
     dictionary lookups; ~12 req/5 min, 30-min CDN cache. PoB export via
     `/poe2/pob/{id}` and `pob2://poeninja/profile/code/{code}`.
   - **Mobalytics** `/poe-2/builds/<slug>` — guides with build JSON embedded as
     `window.__PRELOADED_STATE__` (browser User-Agent required; generic fetch =
     403). Each guide has multiple stage/budget **buildVariants** + equipment/gem/
     ascendancy **priority lists** = the "what to buy next" data we need.
     Reference scraper + PoB converter: `maxrenke/guide2pob`.

4. **Game data (names → stats).**
   Passive tree: GGG official `grindinggear/poe2-skilltree-export` (`data.json`).
   Items/mods/gems: `repoe-fork.github.io/poe2/` (current dumps) + PoB-shaped
   `repoe-fork.github.io/pob-data/poe2/`. poe2db.tw is a human reference, not an API.
   **Spawn weights don't exist in PoE2 data** → any "craft odds" feature is approximate.

5. **PoE2 survival is multi-dimensional.** eHP is per-damage-type and per-hit-size
   (armour formula is hit-size dependent, capped 90%); resistances need
   uncapped/effective/**overcap** tracking (endgame applies ~-60% ele penalty,
   chaos exempt); **Spirit is a hard reservation budget**; **stun threshold** is a
   real defensive axis; trees are **dual weapon-set**. PoB already models all of
   this — we read it, not derive it.

---

## 3. Architecture

```
                ┌─────────────── INGEST ───────────────┐
 PoB2 code  ─┐  │ paste code / char JSON / (later OAuth)│
 char JSON  ─┼─▶│  → normalize → PoB2 XML build         │   src/ingest
 OAuth (L8) ─┘  └───────────────────┬──────────────────┘
                                     ▼
                        ┌─── PoB2 HEADLESS ENGINE ───┐
                        │ compute stats for ANY build│   src/engine
                        │ eHP/type, DPS, res, spirit │   (pob-web WASM; LuaJIT fallback)
                        └─────────────┬──────────────┘
   CORPUS BUILDER (src/corpus)        │
   poe.ninja (protobuf) ─┐           ▼
   mobalytics (guides)   ┼─▶ normalized BuildSpec[] ─▶ MATCH (src/match)
   repoe/tree data ──────┘   (+ computed StatProfile)   nearest meta build by
                                                         ascendancy, main skill,
                                                         weapon, uniques, tree overlap
                                                              │
                                                              ▼
                                       DIFF & PATH PLANNER  (src/plan)
                                  tree Δ, gems to get, items to buy,
                                  ordered by mobalytics level-bands + cost
                                                              │
                                                              ▼
                                  SURVIVAL GUIDE + UPGRADE PATH  (src/report)
                              "fire res 12% under cap · eHP 60% of target ·
                               next: buy <item> (~N ex) → allocate A,B,C"
```

Design wins: (a) one engine scores both sides → matching/diffing on real stats;
(b) mobalytics variants give progression ordering for free; (c) paste-first
import dodges the OAuth wall.

---

## 4. Data model

Defined in `src/types/buildspec.ts`.

- **`PobBuild`** — faithful parse of a `<PathOfBuilding2>` document (level, class,
  trees[] with node-id lists, skill groups + gems, items, slot map, cached stats).
- **`StatProfile`** — computed numbers read from the engine: DPS, Life/ES/Ward,
  Spirit (+reserved), Armour/Evasion/Block, `resists` (current/max/overcap),
  `maxHitTaken` per damage type, stun threshold, and a `raw` passthrough.
- **`BuildSpec`** — normalized build *identity* for matching (class, ascendancy,
  main skill, weapon, key uniques, keystones, notables, tree nodes, stats).
- **`CorpusBuild`** extends it with `popularity` and stage/budget **`BuildVariant`s**.
- **`MatchResult` / `UpgradeStep` / `StatGap` / `SurvivalGuide`** — planner output.

---

## 5. Components & approach

| Module | Responsibility | Approach | Risk |
|---|---|---|---|
| `ingest/pobcode` | decode/parse PoB2 codes | base64url + zlib + fast-xml-parser | low ✅ built |
| `ingest/charjson` | GGG character JSON → PoB2 build | port PoB-PoE2 import mapping | med |
| `ingest/oauth` | PKCE login → fetch character | port PoB-PoE2 flow; **needs GGG approval** | high (external) |
| `engine/pob` | stats for any build | LuaJIT subprocess → vendored PoB-PoE2 `HeadlessWrapper.lua` | ✅ working |
| `corpus/mobalytics` | meta builds + variants | Playwright → `__PRELOADED_STATE__`; pobCode or variant-derived | ✅ working (default) |
| `corpus/pobarchives` | meta builds (PoB codes) | scrape pobarchives→pobb.in, decode, filter PoE2 | ✅ working (no browser) |
| `corpus/poeninja` | ladder builds | protobuf + dictionaries | ⛔ summary-only (no tree/PoB code) — see notes |
| `corpus/gamedata` | tree/item/gem dictionaries | repoe-fork + GGG tree export, cached locally | low |
| `match/matcher` | nearest meta build | weighted feature similarity + tree Jaccard | ✅ working |
| `plan/planner` | current vs target diff → steps | tree node-set diff + skill/item diff | ✅ working |
| `report/survival` | render guide | gap analysis over StatProfile + step list | ✅ working |

**Engine decision (resolved 2026-06-22, Phase 1 spike):** `pob-web`'s WASM is
**not** headless-Node-viable without a major fork (browser-bound driver; never
exports stat numbers — confirmed by inspection). So we drive the **real**
PoB-PoE2 engine via a **LuaJIT subprocess**, which works today:

- LuaJIT from winget `DEVCOM.LuaJIT` (2.1) at `%LOCALAPPDATA%\Programs\LuaJIT\bin\luajit.exe`.
- Vendored `PathOfBuilding-PoE2` under `.vendor/` (gitignored).
- `src/engine/lua/headless_stats.lua` runs with cwd = `<PoB>/src`, sets
  `package.path` (`../runtime/lua/?.lua`) and `package.cpath` (`../runtime/?.dll`
  — PoB's Windows runtime DLLs are ABI-compatible with this LuaJIT; that's how
  `require('lua-utf8')` → `lua-utf8.dll`/`luaopen_utf8` resolves), `dofile`s
  `HeadlessWrapper.lua`, `loadBuildFromXML(xml)`, then dumps every scalar in
  `build.calcsTab.{mainOutput,calcsOutput}` as JSON.
- We feed **XML** (decoded Node-side) because the wrapper stubs `Deflate`/`Inflate`.
- `src/engine/pob.ts` spawns it (stdin closed so a failed boot's `io.read` can't
  hang), parses the JSON, and maps known keys → `StatProfile`. Resist cap is
  `current + MissingResist`; per-type eHP from `*MaximumHitTaken` + `TotalEHP`.

Result: empty build → 624 numeric stats incl. Spirit, StunThreshold, per-type
MaximumHitTaken, resist overcap. Tradeoff accepted: a native LuaJIT dependency
(vs the pure-WASM original pick).

---

## 6. Roadmap (phased)

- **Phase 0 — Scaffold** ✅ repo, TS/Node toolchain, data model, PoB2 code
  decode/parse + tests, `inspect` CLI.
- **Phase 1 — Engine spike** ✅ `engine/pob` computes a `StatProfile` from a PoB2
  code/XML via headless PoB-PoE2 (LuaJIT subprocess). `inspect` + `stats` CLI
  commands; guarded integration test. *Remaining:* validate numbers against a
  **real** PoB2 export (synthetic fixture gives structurally-correct but trivial
  values) — fold in when corpus/import produces real codes.
- **Phase 2 — Game data.** Vendor/cache repoe-fork + GGG tree export. Resolve node
  ids → names/stats, gem/item names ↔ ids. Refine support-gem detection.
- **Phase 3 — Corpus** ✅ *mobalytics (default) + pobarchives*. mobalytics
  (`corpus/mobalytics.ts`) drives **Playwright** (headless Chromium clears
  Cloudflare's JS challenge), reads each build's `window.__PRELOADED_STATE__`, and
  uses its `pobCode` when present or derives the spec from the endgame variant
  (tree node ids + main skill + uniques; class from gem icon, ascendancy from slug).
  Fresh browser context per build (state only injects on first navigation). pobarchives
  (`corpus/pobarchives.ts`) remains a no-browser fallback. `corpus --source ...` CLI.
- **Phase 4 — Corpus: poe.ninja (deferred).** Reachable (version `NNNN-…`,
  `overview=runes-of-aldur`), but the `search` response is **columnar, dictionary-
  encoded protobuf with summary columns only — no passive tree, no PoB code** — so it
  can't drive tree-matching or the path planner. Could layer in *popularity* later.
- **Phase 5 — Matcher** ✅ `match/matcher.ts` + `match` CLI: weighted blend of
  ascendancy / main-skill / tree-Jaccard / uniques / weapon → ranked `MatchResult[]`
  with reasons. Validated: real Stormweaver → closest corpus Stormweaver.
- **Phase 6 — Planner** ✅ `plan/planner.ts`: diff current vs matched target →
  tree node-set delta (allocate/refund counts), skills/supports to acquire, uniques
  to buy → ordered `UpgradeStep[]`. The `plan` CLI command unifies Phases 5–7 into one
  report (closest build + path + survival). Validated on the real Stormweaver build.
  *Later:* per-step cost estimates (price source) and level-band ordering once game
  data + a price feed land.
- **Phase 7 — Survival guide.** ✅ *Standalone gap analysis done* (`report/survival.ts`,
  `guide` CLI): flags uncapped/negative resistances, low eHP-for-level, near-full
  Spirit reservation, missing mitigation layer, weakest damage type; emits gap-driven
  upgrade steps. Validated on real pobb.in builds. *Remaining:* fold in matched-build
  targets (from Phases 4-6) to replace heuristic thresholds with real comparisons.
- **Phase 8 — OAuth import.** Once approved, PKCE login → character → build.
- **Phase 9 — UI.** Web front-end if/when desired (stack already WASM-friendly).

---

## 7. Decisions log

- **2026-06-21** Stack = TypeScript/Node CLI (reconciles "local CLI first" + "TS +
  pob-web WASM"). No Python; no Lua toolchain needed for the WASM path.
- **2026-06-21** Embed PoB-PoE2 for stats; never reimplement the calc engine.
- **2026-06-21** Import is paste-first; OAuth is a parallel, non-blocking track.
- **2026-06-21** League is a parameter; default focus Runes of Aldur.
- **2026-06-22** Engine = LuaJIT subprocess driving vendored PoB-PoE2 (pob-web WASM
  rejected: not headless-Node-viable). Accepts a native LuaJIT dep. Feed XML, not codes.
- **2026-06-22** Corpus source = pobarchives.com (curl-friendly → pobb.in codes), not
  mobalytics/poe.ninja (Cloudflare JS challenge). All build data comes from decoding
  the PoB code; pobarchives is discovery only. Filter to PoE2 by decoded root element.
- **2026-06-22** Default corpus source switched to **mobalytics via Playwright** (user
  request: more current than pobarchives). poe.ninja rejected for the corpus: its build
  API is summary-only protobuf (no tree/PoB code). Gotchas baked in: real Chromium
  clears Cloudflare; shim `globalThis.__name` (esbuild names → browser) before
  `evaluate`; one fresh context per build (`__PRELOADED_STATE__` only on first nav).

---

## 8. Open questions / risks

- ~~pob-web under Node~~ **RESOLVED (Phase 1):** not viable; using LuaJIT subprocess
  + vendored PoB-PoE2 (see Components). New risk: engine setup is a manual step
  (install LuaJIT, clone PoB-PoE2) — needs a setup script before distribution.
- **poe.ninja protobuf**: exact `version`+`overview` request pairing must be
  captured from a live browser session; schema is undocumented and may change.
- **Scraper fragility**: mobalytics `__PRELOADED_STATE__` and poe.ninja API are
  undocumented; pin parsers behind adapters and snapshot fixtures.
- **OAuth approval**: external, manual, possibly slow or denied. Do not block on it.
- **DPS needs skill-selection/config**: on real builds the engine returns correct
  *defences* but often `TotalDPS≈0`, because the auto-selected main socket group
  isn't the damage skill and/or the build needs enemy/config options. Defences (the
  survival guide's domain) are validated; **DPS extraction needs main-skill
  auto-selection (pick best group / honor mainSocketGroup) + sane enemy config** —
  tackle in the matcher phase. Validated builds: real L93/L96 Stormweaver (pobb.in).
- **Cost data**: currency values for "what to buy" need a price source (poe.ninja
  economy API or trade); estimates only, and volatile.
- **Data freshness**: pin game-data dump versions; PoE2 is pre-1.0 and churns each patch.
