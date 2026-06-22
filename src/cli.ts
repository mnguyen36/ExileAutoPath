#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { decodePobCode, parsePobXml } from "./ingest/pobcode.js";

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

program.parseAsync(process.argv);
