// Derive a normalized BuildSpec (the matching identity) from a parsed PobBuild.
//
// Deliberately game-data-free: we match on class/ascendancy/main-skill/uniques/
// weapon + raw passive-node-set overlap, none of which need a node-id->name map.
// Keystone/notable *names* are left empty until the game-data dictionaries land
// (Phase 2); node-set Jaccard already captures tree similarity without them.

import type { PobBuild, BuildSpec, BuildSource } from "../types/buildspec.js";
import { parsePobCode } from "./pobcode.js";

function mainSkillOf(build: PobBuild): string {
  const group =
    build.skills[(build.mainSocketGroup ?? 1) - 1] ?? build.skills.find((g) => g.enabled) ?? build.skills[0];
  return group?.gems.find((g) => !g.isSupport && g.enabled)?.nameSpec ?? group?.gems[0]?.nameSpec ?? "";
}

function allSkillsOf(build: PobBuild): string[] {
  const out = new Set<string>();
  for (const group of build.skills) {
    for (const gem of group.gems) {
      if (!gem.isSupport && gem.nameSpec) out.add(gem.nameSpec);
    }
  }
  return [...out];
}

function keyUniquesOf(build: PobBuild): string[] {
  const seen = new Set<string>();
  for (const it of build.items) {
    if ((it.rarity ?? "").toUpperCase().includes("UNIQUE") && it.name) seen.add(it.name);
  }
  return [...seen];
}

function weaponTypeOf(build: PobBuild): string | undefined {
  const weaponId = build.slots["Weapon 1"] ?? build.slots["Weapon 1 Swap"];
  if (!weaponId) return undefined;
  return build.items.find((i) => i.id === weaponId)?.baseType;
}

export interface ToBuildSpecOptions {
  league?: string;
  pobCode?: string;
}

/** Convert a parsed PoB build into a normalized BuildSpec. */
export function pobBuildToBuildSpec(
  build: PobBuild,
  source: BuildSource,
  id: string,
  opts: ToBuildSpecOptions = {},
): BuildSpec {
  const tree = build.trees[build.activeTreeIndex] ?? build.trees[0];
  return {
    source,
    id,
    league: opts.league,
    className: build.className,
    ascendancy: build.ascendClassName,
    mainSkill: mainSkillOf(build),
    allSkills: allSkillsOf(build),
    weaponType: weaponTypeOf(build),
    keyUniques: keyUniquesOf(build),
    keystones: [],
    notables: [],
    treeNodes: tree?.nodes ?? [],
    level: build.level,
    pobCode: opts.pobCode,
  };
}

/** Decode a PoB2 code and produce a BuildSpec in one step (keeps the code). */
export function codeToBuildSpec(
  code: string,
  source: BuildSource,
  id: string,
  league?: string,
): BuildSpec {
  return pobBuildToBuildSpec(parsePobCode(code), source, id, { league, pobCode: code.trim() });
}
