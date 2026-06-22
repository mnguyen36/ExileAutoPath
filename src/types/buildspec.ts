// Engine-agnostic data model shared across ExileAutoPath.
//
// Two layers of representation:
//   1. PobBuild  - a faithful parse of a Path of Building 2 build (root <PathOfBuilding2>).
//   2. BuildSpec - a normalized "build identity" used for matching / comparison,
//                  derived from a PobBuild (or scraped from a corpus source).
// Computed numbers live in StatProfile (read from the PoB engine), and the
// planner output lives in SurvivalGuide / UpgradeStep.

/** A PoE2 damage type. Used for per-type effective-HP (eHP is not a scalar). */
export type DamageType = "Physical" | "Fire" | "Cold" | "Lightning" | "Chaos";

/** Resistances that have a cap and an overcap margin. */
export type ElementalResist = "Fire" | "Cold" | "Lightning" | "Chaos";

// ---------------------------------------------------------------------------
// Layer 1: parsed Path of Building 2 build
// ---------------------------------------------------------------------------

/** A gem (active or support) inside a socket group. */
export interface Gem {
  nameSpec: string; // display name as stored in PoB
  skillId?: string; // PoB internal skill id
  gemId?: string;
  level: number;
  quality: number;
  enabled: boolean;
  isSupport: boolean; // heuristic for now; refine with gem DB (see TODO in pobcode.ts)
}

/** A socket group = an active skill plus its supports (PoB <Skill>). */
export interface SkillGroup {
  label?: string;
  slot?: string; // gear slot the group is socketed in (PoE1-ism; PoE2 skills self-socket)
  mainActiveSkill?: number;
  enabled: boolean;
  gems: Gem[];
}

/** A passive tree spec. PoE2 supports two weapon-set trees per character. */
export interface TreeSpec {
  title?: string;
  treeVersion: string; // e.g. "0_5"
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId?: number;
  nodes: number[]; // allocated passive node ids
}

/** A single equipped item: PoB raw text plus a light structured header. */
export interface Item {
  id: string;
  slot?: string; // resolved gear slot, when known
  rarity?: string;
  name?: string;
  baseType?: string;
  raw: string; // full multi-line PoB item text
}

/** A parsed Path of Building build. */
export interface PobBuild {
  isPoE2: boolean; // true if root was <PathOfBuilding2> (vs PoE1 <PathOfBuilding>)
  level: number;
  className: string;
  ascendClassName: string;
  mainSocketGroup?: number;
  trees: TreeSpec[];
  activeTreeIndex: number;
  skills: SkillGroup[];
  items: Item[];
  slots: Record<string, string>; // slot name -> item id (active item set)
  cachedStats: Record<string, number>; // <PlayerStat> values baked into the code
  xml: string; // original decoded XML, for re-export / debugging
}

// ---------------------------------------------------------------------------
// Computed stats (read from the PoB engine, not derived here)
// ---------------------------------------------------------------------------

/** Largest single hit of a given type the character can survive. */
export type MaxHitTaken = Partial<Record<DamageType, number>>;

export interface ResistProfile {
  current: number; // effective value PoB reports, clamped to the cap (after endgame penalty)
  total: number; // uncapped total
  max: number; // the cap (75 default, up to 90 with +max res). max = current + missing
  overcap: number; // wasted resistance above the cap (>= 0)
  missing: number; // how far below the cap (>= 0); 0 once capped
}

/** The stats ExileAutoPath surfaces, read from the PoB engine output table. */
export interface StatProfile {
  // offence
  totalDPS?: number;
  fullDPS?: number;
  // hit pools
  life?: number;
  energyShield?: number;
  ward?: number;
  mana?: number;
  // spirit budget (a hard reservation cap in PoE2)
  spirit?: number;
  spiritReserved?: number;
  // mitigation
  armour?: number;
  evasion?: number;
  blockChance?: number;
  // resistances, with overcap margin
  resists: Partial<Record<ElementalResist, ResistProfile>>;
  // survivability per damage type
  maxHitTaken: MaxHitTaken;
  totalEHP?: number; // PoB's blended TotalEHP
  // stun (a first-class defensive axis in PoE2)
  stunThreshold?: number;
  // everything PoB emitted, for flexibility
  raw: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Layer 2: normalized build identity (for matching) + corpus entries
// ---------------------------------------------------------------------------

export type BuildSource = "user" | "poe.ninja" | "mobalytics" | "pobarchives";

/** The features that define a build's identity, used for matching. */
export interface BuildSpec {
  source: BuildSource;
  id: string;
  league?: string;
  className: string;
  ascendancy: string;
  mainSkill: string;
  weaponType?: string;
  keyUniques: string[];
  keystones: string[];
  notables: string[];
  treeNodes: number[];
  level: number;
  stats?: StatProfile;
  pobCode?: string; // exportable PoB2 code, when available
}

/** A meta build in the corpus, possibly with leveling/budget variants. */
export interface CorpusBuild extends BuildSpec {
  popularity?: number; // ladder count / rank weight
  variants?: BuildVariant[]; // mobalytics-style stage/budget snapshots
  sourceUrl?: string;
}

/** A single stage/budget snapshot of a build (mobalytics buildVariants). */
export interface BuildVariant {
  label: string; // "ACT 1", "ENDGAME", "ENDGAME (BUDGET)"
  approxLevel?: number;
  treeNodes: number[];
  gems: { skill: string; supports: string[] }[];
  items: { slot: string; name: string; isUnique: boolean; mods?: string[] }[];
  itemPriority?: string[]; // "what to buy next" ordering
}

// ---------------------------------------------------------------------------
// Matching + planning output
// ---------------------------------------------------------------------------

export interface MatchResult {
  target: CorpusBuild;
  score: number; // 0..1 similarity
  reasons: string[];
}

export type UpgradeKind = "passive" | "gem" | "item" | "config";

export interface UpgradeStep {
  kind: UpgradeKind;
  description: string;
  detail?: string;
  approxLevel?: number;
  estCost?: { amount: number; currency: string };
  statDelta?: Partial<Record<string, number>>;
}

export type GapSeverity = "critical" | "warn" | "ok";

export interface StatGap {
  stat: string;
  current?: number;
  target?: number;
  severity: GapSeverity;
  note: string;
}

export interface SurvivalGuide {
  summary: string;
  gaps: StatGap[];
  path: UpgradeStep[];
}
