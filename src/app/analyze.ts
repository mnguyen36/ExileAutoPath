// The shared analysis pipeline: a build input + a corpus -> the full report
// data (user, stats, top matches, path, survival guide). Used by both the
// `plan` CLI command and the web server so they never drift.

import { decodePobCode, parsePobXml } from "../ingest/pobcode.js";
import { pobBuildToBuildSpec } from "../ingest/buildspec.js";
import { computeStatsFromXmlAsync, engineAvailable } from "../engine/pob.js";
import { matchBuilds } from "../match/matcher.js";
import { planPath } from "../plan/planner.js";
import { analyzeSurvival } from "../report/survival.js";
import type {
  CorpusBuild,
  StatProfile,
  MatchResult,
  BuildPath,
  SurvivalGuide,
} from "../types/buildspec.js";

export interface AnalyzeInput {
  code?: string; // PoB2 import code OR raw XML (auto-detected)
  xml?: string; // explicit XML
}

export interface AnalyzeOptions {
  topN?: number;
  computeStats?: boolean; // default true when the engine is available
}

export interface AnalyzeResult {
  user: { className: string; ascendancy: string; mainSkill: string; level: number };
  stats?: StatProfile;
  engineError?: string;
  matches: MatchResult[];
  path?: BuildPath;
  guide?: SurvivalGuide;
  // Allocated passive-node ids for the tree view: yours, and the #1 match's.
  userNodes: number[];
  targetNodes: number[];
}

/** Decode/parse a build, match it against the corpus, plan the path, and (if the
 *  engine is available) compute stats + the survival guide. */
export async function analyze(
  input: AnalyzeInput,
  corpus: readonly CorpusBuild[],
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const raw = input.xml ?? input.code;
  if (!raw || raw.trim().length === 0) {
    throw new Error("No build provided — paste a Path of Building 2 code or XML.");
  }
  const xml = raw.trimStart().startsWith("<") ? raw : decodePobCode(raw);
  const build = parsePobXml(xml);
  const user = pobBuildToBuildSpec(build, "user", "you");

  const matches = matchBuilds(user, [...corpus], opts.topN ?? 3);
  const path = matches[0] ? planPath(build, matches[0]) : undefined;

  let stats: StatProfile | undefined;
  let guide: SurvivalGuide | undefined;
  let engineError: string | undefined;
  const wantStats = opts.computeStats ?? true;
  if (wantStats && engineAvailable()) {
    try {
      const r = await computeStatsFromXmlAsync(xml);
      if (r.ok) {
        stats = r.stats;
        guide = analyzeSurvival(stats, {
          level: build.level,
          className: build.className,
          ascendancy: build.ascendClassName,
        });
      } else {
        engineError = r.error ?? "engine error";
      }
    } catch (e) {
      engineError = (e as Error).message;
    }
  } else if (wantStats) {
    engineError = "engine unavailable (LuaJIT / PoB checkout not found)";
  }

  return {
    user: {
      className: build.className,
      ascendancy: build.ascendClassName,
      mainSkill: user.mainSkill,
      level: build.level,
    },
    stats,
    engineError,
    matches,
    path,
    guide,
    userNodes: user.treeNodes,
    targetNodes: matches[0]?.target.treeNodes ?? [],
  };
}
