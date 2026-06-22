#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodePobCode, parsePobXml } from "./ingest/pobcode.js";
import {
  computeStatsFromXml,
  computeStatsFromCode,
  engineAvailable,
} from "./engine/pob.js";
import { analyzeSurvival, renderSurvivalGuide } from "./report/survival.js";
import { pobBuildToBuildSpec } from "./ingest/buildspec.js";
import { buildCorpus } from "./corpus/pobarchives.js";
import { matchBuilds } from "./match/matcher.js";
import { planPath, renderBuildPath } from "./plan/planner.js";
import type { ResistProfile, CorpusBuild } from "./types/buildspec.js";

function loadCorpus(path: string): CorpusBuild[] | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CorpusBuild[];
  } catch {
    return null;
  }
}

const program = new Command();

program
  .name("exileautopath")
  .description(
    "PoE2 auto-builder: import a build, match the closest meta build, and plan the upgrade path.",
  )
  .version("0.1.0");

program
  .command("inspect")
  .description("Decode a Path of Building 2 code and summarise the build")
  .argument("[code]", "PoB2 import code (or use --file)")
  .option("-f, --file <path>", "read the code (or raw XML) from a file")
  .option("--xml", "print the decoded XML instead of a summary")
  .action((code: string | undefined, opts: { file?: string; xml?: boolean }) => {
    const raw = opts.file ? readFileSync(opts.file, "utf8") : code;
    if (!raw) {
      console.error("Provide a PoB2 code argument or --file <path>.");
      process.exitCode = 1;
      return;
    }
    // Accept either a code or already-decoded XML (handy while developing).
    const xml = raw.trimStart().startsWith("<") ? raw : decodePobCode(raw);
    if (opts.xml) {
      console.log(xml);
      return;
    }
    const b = parsePobXml(xml);
    const tree = b.trees[b.activeTreeIndex] ?? b.trees[0];
    const mainGroup = b.skills[(b.mainSocketGroup ?? 1) - 1] ?? b.skills[0];
    const activeGem = mainGroup?.gems.find((g) => !g.isSupport);

    console.log(`Class:       ${b.className}${b.ascendClassName ? ` (${b.ascendClassName})` : ""}`);
    console.log(`Level:       ${b.level}`);
    console.log(`Tree:        v${tree?.treeVersion ?? "?"}, ${tree?.nodes.length ?? 0} allocated nodes`);
    console.log(`Main skill:  ${activeGem?.nameSpec ?? "(unknown)"}`);
    console.log(`Skill groups:${b.skills.length}`);
    console.log(`Items:       ${b.items.length}`);
    const cached = Object.entries(b.cachedStats);
    if (cached.length) {
      const preview = cached
        .slice(0, 8)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      console.log(`Cached stats: ${preview}${cached.length > 8 ? " …" : ""}`);
      console.log("  (note: these are baked into the code; real stats come from the PoB engine)");
    }
  });

program
  .command("stats")
  .description("Compute live stats for a build via the headless Path of Building 2 engine")
  .argument("[code]", "PoB2 import code (or use --file)")
  .option("-f, --file <path>", "read the code (or raw XML) from a file")
  .option("--json", "print the full StatProfile as JSON")
  .action((code: string | undefined, opts: { file?: string; json?: boolean }) => {
    if (!engineAvailable()) {
      console.error(
        "PoB engine unavailable. Needs LuaJIT (set POB_LUAJIT) and .vendor/PathOfBuilding-PoE2.\n" +
          "See docs/ARCHITECTURE.md (Engine).",
      );
      process.exitCode = 1;
      return;
    }
    const raw = opts.file ? readFileSync(opts.file, "utf8") : code;
    if (!raw) {
      console.error("Provide a PoB2 code argument or --file <path>.");
      process.exitCode = 1;
      return;
    }
    const isXml = raw.trimStart().startsWith("<");
    const result = isXml ? computeStatsFromXml(raw) : computeStatsFromCode(raw);
    if (!result.ok) {
      console.error("Engine error:", result.error ?? "unknown");
      process.exitCode = 1;
      return;
    }
    const s = result.stats;
    if (opts.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    const f = (x?: number, d = 0) =>
      x === undefined ? "—" : x.toLocaleString("en-US", { maximumFractionDigits: d });
    // Cold/Chaos both start with C, so use disambiguated short labels.
    const SHORT: Record<string, string> = {
      Physical: "Phys",
      Fire: "Fire",
      Cold: "Cold",
      Lightning: "Lght",
      Chaos: "Chao",
    };
    const resistLine = (Object.entries(s.resists) as [string, ResistProfile | undefined][])
      .filter((e): e is [string, ResistProfile] => e[1] !== undefined)
      .map(([el, r]) => `${SHORT[el] ?? el} ${r.current}/${r.max}${r.overcap > 0 ? `(+${r.overcap})` : ""}`)
      .join("  ");
    const hitLine = Object.entries(s.maxHitTaken)
      .map(([t, v]) => `${SHORT[t] ?? t} ${f(v)}`)
      .join("  ");

    console.log(`Computed via headless PoB2 (${result.rawCount} raw stats)\n`);
    console.log(`DPS:      Total ${f(s.totalDPS)}    Full ${f(s.fullDPS)}`);
    console.log(`Pools:    Life ${f(s.life)}   ES ${f(s.energyShield)}   Ward ${f(s.ward)}   Mana ${f(s.mana)}`);
    console.log(`Spirit:   ${f(s.spirit)} (reserved ${f(s.spiritReserved)})`);
    console.log(`Defence:  Armour ${f(s.armour)}   Evasion ${f(s.evasion)}   Block ${f(s.blockChance)}%`);
    console.log(`Resists:  ${resistLine || "—"}`);
    console.log(`Max hit:  ${hitLine || "—"}    TotalEHP ${f(s.totalEHP)}`);
    console.log(`Stun threshold: ${f(s.stunThreshold)}`);
  });

program
  .command("guide")
  .description("Survival guide: compute stats and flag what you're low on / what to upgrade next")
  .argument("[code]", "PoB2 import code (or use --file)")
  .option("-f, --file <path>", "read the code (or raw XML) from a file")
  .option("--json", "print the SurvivalGuide as JSON")
  .action((code: string | undefined, opts: { file?: string; json?: boolean }) => {
    if (!engineAvailable()) {
      console.error(
        "PoB engine unavailable. Needs LuaJIT (set POB_LUAJIT) and .vendor/PathOfBuilding-PoE2.",
      );
      process.exitCode = 1;
      return;
    }
    const raw = opts.file ? readFileSync(opts.file, "utf8") : code;
    if (!raw) {
      console.error("Provide a PoB2 code argument or --file <path>.");
      process.exitCode = 1;
      return;
    }
    const xml = raw.trimStart().startsWith("<") ? raw : decodePobCode(raw);
    const build = parsePobXml(xml);
    const result = computeStatsFromXml(xml);
    if (!result.ok) {
      console.error("Engine error:", result.error ?? "unknown");
      process.exitCode = 1;
      return;
    }
    const guide = analyzeSurvival(result.stats, {
      level: build.level,
      className: build.className,
      ascendancy: build.ascendClassName,
    });
    if (opts.json) {
      console.log(JSON.stringify(guide, null, 2));
      return;
    }
    console.log(renderSurvivalGuide(guide));
  });

program
  .command("corpus")
  .description("Build a local meta-build corpus by scraping pobarchives -> pobb.in PoB2 codes")
  .option("--league <name>", "tag builds with this league")
  .option("--game <g>", "poe2 or poe1", "poe2")
  .option("--limit <n>", "target number of builds to collect", "20")
  .option("--scan <n>", "max candidates to examine (default limit*4)")
  .option("-o, --out <path>", "output corpus JSON", "data/corpus.json")
  .action(
    async (opts: { league?: string; game: string; limit: string; scan?: string; out: string }) => {
      const corpus = await buildCorpus({
        game: opts.game,
        league: opts.league,
        limit: Number(opts.limit),
        scan: opts.scan ? Number(opts.scan) : undefined,
        onProgress: (m) => console.error(m), // progress on stderr; result path on stdout
      });
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(corpus, null, 2));
    console.log(`Saved ${corpus.length} builds to ${opts.out}`);
  });

program
  .command("match")
  .description("Match your build to the closest builds in the corpus")
  .argument("[code]", "PoB2 import code (or use --file)")
  .option("-f, --file <path>", "read your code (or raw XML) from a file")
  .option("-c, --corpus <path>", "corpus JSON", "data/corpus.json")
  .option("-n, --top <n>", "number of results", "5")
  .action((code: string | undefined, opts: { file?: string; corpus: string; top: string }) => {
    const raw = opts.file ? readFileSync(opts.file, "utf8") : code;
    if (!raw) {
      console.error("Provide a PoB2 code argument or --file <path>.");
      process.exitCode = 1;
      return;
    }
    const xml = raw.trimStart().startsWith("<") ? raw : decodePobCode(raw);
    const user = pobBuildToBuildSpec(parsePobXml(xml), "user", "you");
    let corpus: CorpusBuild[];
    try {
      corpus = JSON.parse(readFileSync(opts.corpus, "utf8")) as CorpusBuild[];
    } catch {
      console.error(`No corpus at ${opts.corpus}. Build one first:  cli corpus --out ${opts.corpus}`);
      process.exitCode = 1;
      return;
    }
    const results = matchBuilds(user, corpus, Number(opts.top));
    console.log(
      `You: ${user.ascendancy || user.className} / ${user.mainSkill || "?"} (L${user.level})\n`,
    );
    console.log(`Closest of ${corpus.length} builds:`);
    if (results.length === 0) {
      console.log("  (corpus is empty)");
      return;
    }
    results.forEach((r, i) => {
      const t = r.target;
      console.log(
        `  ${i + 1}. [${(r.score * 100).toFixed(0)}%] ${t.ascendancy || t.className} / ${t.mainSkill || "?"} (L${t.level})  ${t.sourceUrl ?? ""}`,
      );
      console.log(`        ${r.reasons.join("; ") || "weak match"}`);
    });
  });

program
  .command("plan")
  .description("Full report: closest meta build, the path to it, and what you're low on")
  .argument("[code]", "PoB2 import code (or use --file)")
  .option("-f, --file <path>", "read your code (or raw XML) from a file")
  .option("-c, --corpus <path>", "corpus JSON", "data/corpus.json")
  .action((code: string | undefined, opts: { file?: string; corpus: string }) => {
    const raw = opts.file ? readFileSync(opts.file, "utf8") : code;
    if (!raw) {
      console.error("Provide a PoB2 code argument or --file <path>.");
      process.exitCode = 1;
      return;
    }
    const xml = raw.trimStart().startsWith("<") ? raw : decodePobCode(raw);
    const build = parsePobXml(xml);
    const user = pobBuildToBuildSpec(build, "user", "you");

    console.log(
      `You: ${build.className}${build.ascendClassName ? ` (${build.ascendClassName})` : ""} / ${user.mainSkill || "?"} — level ${build.level}\n`,
    );

    const corpus = loadCorpus(opts.corpus);
    if (!corpus) {
      console.error(`No corpus at ${opts.corpus}. Build one first:  cli corpus --out ${opts.corpus}`);
      process.exitCode = 1;
      return;
    }
    const best = matchBuilds(user, corpus, 1)[0];
    if (!best) {
      console.log("Corpus is empty — nothing to match against.");
    } else {
      console.log(renderBuildPath(planPath(build, best)));
    }

    // Survivability (needs the engine).
    if (engineAvailable()) {
      const result = computeStatsFromXml(xml);
      if (result.ok) {
        const guide = analyzeSurvival(result.stats, {
          level: build.level,
          className: build.className,
          ascendancy: build.ascendClassName,
        });
        console.log("\n" + renderSurvivalGuide(guide));
      } else {
        console.log(`\n(could not compute stats: ${result.error ?? "unknown"})`);
      }
    } else {
      console.log("\n(install the PoB engine for the survivability section — see README)");
    }
  });

program.parseAsync(process.argv);
