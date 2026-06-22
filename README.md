# ExileAutoPath

A Path of Exile 2 **auto-builder**. Import your character, match it to the closest
real meta build, and get a **path to the final build** — which passives to take, which
gems to acquire, what to buy next — plus a **survival guide** that tells you which stats
you're low on.

> Status: **early scaffold (v0.1)**. Working today: decode + parse a Path of Building 2
> import code. Everything else is specified in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> and being built in phases.

## Why it works the way it does

- **Stats come from Path of Building 2, not from us.** Reimplementing PoE2's damage/defence
  math (~16k lines of Lua + a giant mod parser, re-tuned every patch) is a losing game. We
  drive the real engine headless and read its output. The *same* engine scores your build
  and every meta build, so comparisons are apples-to-apples.
- **Two build corpora.** [poe.ninja](https://poe.ninja/poe2/builds) = what people actually
  play (ladder snapshots). [Mobalytics](https://mobalytics.gg/poe-2) = curated guides whose
  multi-stage variants already encode a leveling → endgame **upgrade path**.
- **Import is paste-first.** PoE2 character data is only reachable through GGG's OAuth API
  (no Steam, no public scraping), and OAuth client registration is manual. So we start by
  pasting a PoB2 code / character JSON, and pursue OAuth in parallel.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, data sources, and roadmap.

## Develop

```bash
npm install
npm test            # vitest (engine integration test auto-skips if no engine)
npm run typecheck   # tsc --noEmit
npm run cli -- inspect --file fixtures/example.pob   # decode + summarise a PoB2 code
npm run cli -- stats   --file fixtures/example.pob   # compute live stats via headless PoB2
npm run cli -- guide   --file fixtures/example.pob   # survival guide: what you're low on + next upgrades
```

The `inspect`/`stats`/`guide` commands also accept a code as a positional arg
(`npm run cli -- guide <pob2-code>`) or raw XML.

### Engine setup (for `stats` / live computation)

Stats are computed by driving the real Path of Building 2 engine headless via a
LuaJIT subprocess. One-time setup on Windows:

```bash
winget install --id DEVCOM.LuaJIT          # LuaJIT 2.1
git clone --depth 1 -b dev \
  https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2.git \
  .vendor/PathOfBuilding-PoE2
```

Defaults auto-detect LuaJIT at `%LOCALAPPDATA%\Programs\LuaJIT\bin\luajit.exe`
and PoB at `.vendor/PathOfBuilding-PoE2/src`. Override with `POB_LUAJIT` /
`POB_SRC`. If the engine isn't present, `stats` reports it and the integration
test skips.

## Layout

```
src/
  types/     shared data model (PobBuild, BuildSpec, StatProfile, SurvivalGuide…)
  ingest/    PoB2 code decode/parse; (later) GGG character JSON -> build; OAuth
  engine/    headless Path of Building 2 stat computation
  corpus/    poe.ninja + mobalytics scrapers -> normalized builds
  match/     nearest meta-build matcher
  plan/      diff current vs target -> ordered upgrade path
  report/    survival guide renderer
docs/        ARCHITECTURE.md (spec + roadmap)
```

## License

MIT
