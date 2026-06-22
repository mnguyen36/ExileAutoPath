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
| `engine/pob` | stats for any build | pob-web WASM in Node; LuaJIT subprocess fallback | **highest** |
| `corpus/poeninja` | ladder builds | protobuf decode + dictionary resolve; cache | med-high |
| `corpus/mobalytics` | guide variants | `__PRELOADED_STATE__` JSON (browser UA) | med |
| `corpus/gamedata` | tree/item/gem dictionaries | repoe-fork + GGG tree export, cached locally | low |
| `match/matcher` | nearest meta build | weighted feature similarity + tree Jaccard | med |
| `plan/planner` | current vs target diff → steps | set diffs + level-band ordering + cost lookup | med |
| `report/survival` | render guide | gap analysis over StatProfile + step list | low |

**Engine decision:** chosen stack is TypeScript/Node + `pob-web` WASM so one
language spans engine and (future) UI, and no Lua toolchain is required (none is
installed locally). The headless stat extraction is the project's #1 risk; if
pob-web-in-Node proves impractical, fall back to driving real PoB-PoE2 via a
bundled LuaJIT subprocess. **This is the next thing to spike.**

---

## 6. Roadmap (phased)

- **Phase 0 — Scaffold** ✅ repo, TS/Node toolchain, data model, PoB2 code
  decode/parse + tests, `inspect` CLI.
- **Phase 1 — Engine spike (next).** Stand up `engine/pob`: feed a real PoB2 code,
  get back a `StatProfile`. Validate pob-web under Node; decide engine path. Add a
  real PoB2 export to `fixtures/`. *Exit:* `compute(code) → StatProfile` works.
- **Phase 2 — Game data.** Vendor/cache repoe-fork + GGG tree export. Resolve node
  ids → names/stats, gem/item names ↔ ids. Refine support-gem detection.
- **Phase 3 — Corpus: mobalytics.** Scrape a guide → `CorpusBuild` with variants +
  priority lists. (Easier than poe.ninja; gives upgrade-path structure first.)
- **Phase 4 — Corpus: poe.ninja.** Capture live `search`/`tooltip`/`dictionary`
  requests, decode protobuf → `CorpusBuild[]` per league, cached.
- **Phase 5 — Matcher.** `BuildSpec` → ranked `MatchResult[]`.
- **Phase 6 — Planner.** Diff current vs matched target → ordered `UpgradeStep[]`.
- **Phase 7 — Survival guide.** Gap analysis + render. End-to-end CLI:
  `exileautopath plan --file my.pob`.
- **Phase 8 — OAuth import.** Once approved, PKCE login → character → build.
- **Phase 9 — UI.** Web front-end if/when desired (stack already WASM-friendly).

---

## 7. Decisions log

- **2026-06-21** Stack = TypeScript/Node CLI (reconciles "local CLI first" + "TS +
  pob-web WASM"). No Python; no Lua toolchain needed for the WASM path.
- **2026-06-21** Embed PoB-PoE2 for stats; never reimplement the calc engine.
- **2026-06-21** Import is paste-first; OAuth is a parallel, non-blocking track.
- **2026-06-21** League is a parameter; default focus Runes of Aldur.

---

## 8. Open questions / risks

- **pob-web under Node**: built for the browser — confirm it runs headless in Node,
  or vendor a LuaJIT + PoB-PoE2 checkout and shell out. (Phase 1 resolves this.)
- **poe.ninja protobuf**: exact `version`+`overview` request pairing must be
  captured from a live browser session; schema is undocumented and may change.
- **Scraper fragility**: mobalytics `__PRELOADED_STATE__` and poe.ninja API are
  undocumented; pin parsers behind adapters and snapshot fixtures.
- **OAuth approval**: external, manual, possibly slow or denied. Do not block on it.
- **Cost data**: currency values for "what to buy" need a price source (poe.ninja
  economy API or trade); estimates only, and volatile.
- **Data freshness**: pin game-data dump versions; PoE2 is pre-1.0 and churns each patch.
