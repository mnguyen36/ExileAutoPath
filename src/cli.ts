#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { decodePobCode, parsePobXml } from "./ingest/pobcode.js";
import {
  computeStatsFromXml,
  computeStatsFromCode,
  engineAvailable,
} from "./engine/pob.js";
import { analyzeSurvival, renderSurvivalGuide } from "./report/survival.js";
import type { ResistProfile } from "./types/buildspec.js";

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

program.parseAsync(process.argv);
