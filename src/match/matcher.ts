// Match a user's BuildSpec to the closest builds in a corpus.
//
// Similarity is a weighted blend of categorical features (ascendancy, main
// skill, weapon) and set overlap (passive-tree node ids, key uniques). Tree
// overlap via Jaccard is the workhorse — it needs no game-data dictionary and
// captures "how similar is this passive tree" directly from the allocated ids.

import type { BuildSpec, CorpusBuild, MatchResult } from "../types/buildspec.js";

export interface MatchWeights {
  ascendancy: number;
  mainSkill: number;
  tree: number;
  uniques: number;
  weapon: number;
}

// Sum to 1.0 so the final score is a clean 0..1.
export const DEFAULT_WEIGHTS: MatchWeights = {
  ascendancy: 0.3,
  mainSkill: 0.28,
  tree: 0.27,
  uniques: 0.1,
  weapon: 0.05,
};

function jaccard<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  const seen = new Set<T>();
  for (const x of a) {
    if (seen.has(x)) continue;
    seen.add(x);
    if (setB.has(x)) inter++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

const norm = (s: string) => s.trim().toLowerCase();

function skillSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.5; // e.g. "Spark" vs "Spark of …"
  return 0;
}

/** Score one target against the user build. Returns score (0..1) + reasons. */
export function scoreMatch(
  user: BuildSpec,
  target: CorpusBuild,
  weights: MatchWeights = DEFAULT_WEIGHTS,
): MatchResult {
  const sameAsc = norm(user.ascendancy) === norm(target.ascendancy) && user.ascendancy !== "";
  const sameClass = norm(user.className) === norm(target.className) && user.className !== "";
  const cAsc = sameAsc ? 1 : sameClass ? 0.4 : 0;
  const cSkill = skillSimilarity(user.mainSkill, target.mainSkill);
  const cTree = jaccard(user.treeNodes, target.treeNodes);
  const cUniq = jaccard(user.keyUniques.map(norm), target.keyUniques.map(norm));
  const cWeapon =
    user.weaponType && target.weaponType && norm(user.weaponType) === norm(target.weaponType) ? 1 : 0;

  const score =
    weights.ascendancy * cAsc +
    weights.mainSkill * cSkill +
    weights.tree * cTree +
    weights.uniques * cUniq +
    weights.weapon * cWeapon;

  const reasons: string[] = [];
  if (sameAsc) reasons.push(`same ascendancy (${target.ascendancy})`);
  else if (sameClass) reasons.push(`same class (${target.className}), different ascendancy`);
  if (cSkill === 1) reasons.push(`same main skill (${target.mainSkill})`);
  else if (cSkill > 0) reasons.push(`related main skill (${target.mainSkill})`);
  if (cTree > 0) reasons.push(`${Math.round(cTree * 100)}% passive-tree overlap`);
  const sharedUniques = user.keyUniques.filter((u) =>
    target.keyUniques.some((t) => norm(t) === norm(u)),
  );
  if (sharedUniques.length) reasons.push(`shared uniques: ${sharedUniques.slice(0, 3).join(", ")}`);
  if (cWeapon === 1) reasons.push(`same weapon type (${target.weaponType})`);

  return { target, score, reasons };
}

/** Rank a corpus against the user build, best first. */
export function matchBuilds(
  user: BuildSpec,
  corpus: readonly CorpusBuild[],
  topN = 5,
  weights: MatchWeights = DEFAULT_WEIGHTS,
): MatchResult[] {
  return corpus
    .map((c) => scoreMatch(user, c, weights))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
