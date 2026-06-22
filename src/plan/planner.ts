// Path planner: diff a current build against a matched target build into an
// ordered set of upgrade steps (which skills/supports to get, which uniques to
// buy, how much passive tree to re-spec). Combined with the survival guide in
// the CLI to produce the full "build path + what you're low on" report.
//
// Tree diff is by node-id set (no game-data dictionary needed). Skill/item diff
// decodes the target's stored PoB code; if it's absent we fall back to the
// target's BuildSpec-level key uniques.

import type { PobBuild, CorpusBuild, MatchResult, UpgradeStep, BuildPath } from "../types/buildspec.js";
import { parsePobCode } from "../ingest/pobcode.js";

const norm = (s: string) => s.trim().toLowerCase();

function activeTree(build: PobBuild): number[] {
  return (build.trees[build.activeTreeIndex] ?? build.trees[0])?.nodes ?? [];
}

function gemNames(build: PobBuild, support: boolean): string[] {
  const out: string[] = [];
  for (const group of build.skills) {
    for (const gem of group.gems) {
      if (gem.isSupport === support && gem.nameSpec) out.push(gem.nameSpec);
    }
  }
  return [...new Set(out)];
}

function missingFrom(targetNames: string[], userNames: string[]): string[] {
  const have = new Set(userNames.map(norm));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of targetNames) {
    const key = norm(name);
    if (!have.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/** Build the upgrade path from the user's build toward a matched target. */
export function planPath(user: PobBuild, match: MatchResult): BuildPath {
  const target = match.target;

  // Tree delta by node-id set.
  const userNodes = new Set(activeTree(user));
  const targetNodes = target.treeNodes;
  const targetSet = new Set(targetNodes);
  const treeToAllocate = targetNodes.filter((n) => !userNodes.has(n)).length;
  let treeToRefund = 0;
  for (const n of userNodes) if (!targetSet.has(n)) treeToRefund++;

  // Skill / item delta — needs the target's full build; decode if we have it.
  let skillsToAcquire: string[] = [];
  let supportsToAdd: string[] = [];
  let uniquesToBuy: string[] = [];
  if (target.pobCode) {
    try {
      const tb = parsePobCode(target.pobCode);
      skillsToAcquire = missingFrom(gemNames(tb, false), gemNames(user, false));
      supportsToAdd = missingFrom(gemNames(tb, true), gemNames(user, true));
      const userUniques = user.items
        .filter((i) => (i.rarity ?? "").toUpperCase().includes("UNIQUE"))
        .map((i) => i.name ?? "");
      const targetUniques = tb.items
        .filter((i) => (i.rarity ?? "").toUpperCase().includes("UNIQUE"))
        .map((i) => i.name ?? "")
        .filter(Boolean);
      uniquesToBuy = missingFrom(targetUniques, userUniques);
    } catch {
      // fall through to BuildSpec-level uniques
    }
  }
  if (uniquesToBuy.length === 0 && target.keyUniques.length > 0) {
    const userUniques = user.items
      .filter((i) => (i.rarity ?? "").toUpperCase().includes("UNIQUE"))
      .map((i) => i.name ?? "");
    uniquesToBuy = missingFrom(target.keyUniques, userUniques);
  }

  // Order: align the damage skill, then enabling uniques, then supports, then tree.
  const steps: UpgradeStep[] = [];
  if (skillsToAcquire.length > 0) {
    steps.push({
      kind: "gem",
      description: `Set up the target's main skill${skillsToAcquire.length > 1 ? "s" : ""}: ${skillsToAcquire.slice(0, 4).join(", ")}.`,
    });
  }
  for (const u of uniquesToBuy.slice(0, 6)) {
    steps.push({ kind: "item", description: `Acquire unique: ${u}.` });
  }
  if (supportsToAdd.length > 0) {
    steps.push({
      kind: "gem",
      description: `Add support gems: ${supportsToAdd.slice(0, 6).join(", ")}${supportsToAdd.length > 6 ? ", …" : ""}.`,
    });
  }
  if (treeToAllocate > 0 || treeToRefund > 0) {
    steps.push({
      kind: "passive",
      description: `Re-spec the passive tree toward the target: allocate ~${treeToAllocate} node${treeToAllocate === 1 ? "" : "s"}${treeToRefund > 0 ? `, refund ~${treeToRefund} off-plan` : ""}.`,
      statDelta: { passivesToAllocate: treeToAllocate },
    });
  }

  return {
    target,
    matchScore: match.score,
    matchReasons: match.reasons,
    treeToAllocate,
    treeToRefund,
    skillsToAcquire,
    supportsToAdd,
    uniquesToBuy,
    steps,
  };
}

/** Render a BuildPath as plain text for the CLI. */
export function renderBuildPath(path: BuildPath): string {
  const t = path.target;
  const lines: string[] = [];
  lines.push(
    `Closest build: ${t.ascendancy || t.className} / ${t.mainSkill || "?"} (${t.level > 0 ? `L${t.level}` : "endgame"}) — ${(path.matchScore * 100).toFixed(0)}% match`,
  );
  if (t.sourceUrl) lines.push(`  ${t.sourceUrl}`);
  if (path.matchReasons.length) lines.push(`  Why: ${path.matchReasons.join("; ")}`);
  lines.push("", "Path to this build:");
  if (path.steps.length === 0) lines.push("  · already aligned with the target");
  path.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.description}`));
  return lines.join("\n");
}
