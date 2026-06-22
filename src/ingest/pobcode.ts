// Decode / parse Path of Building 2 import codes.
//
// A PoB2 import code is: URL-safe base64 ( '+' -> '-', '/' -> '_' ) of a
// zlib-deflated XML document whose root element is <PathOfBuilding2>.
// (PoB1 uses <PathOfBuilding>; the two are NOT cross-compatible.)

import { inflateSync, inflateRawSync, deflateSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import type { PobBuild, TreeSpec, SkillGroup, Gem, Item } from "../types/buildspec.js";

/** Decode a Path of Building import code into its raw XML string. */
export function decodePobCode(code: string): string {
  const cleaned = code.trim().replace(/\s+/g, "");
  // Reverse PoB's URL-safe base64 alphabet.
  const b64 = cleaned.replace(/-/g, "+").replace(/_/g, "/");
  const compressed = Buffer.from(b64, "base64");
  // PoB's Deflate is zlib-wrapped; fall back to raw deflate defensively.
  let xml: Buffer;
  try {
    xml = inflateSync(compressed);
  } catch {
    xml = inflateRawSync(compressed);
  }
  return xml.toString("utf8");
}

/** Encode raw PoB XML into an import code. Round-trips decodePobCode(). */
export function encodePobCode(xml: string): string {
  const compressed = deflateSync(Buffer.from(xml, "utf8"));
  return compressed.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false, // keep attrs as strings; we coerce explicitly
  trimValues: false, // preserve item text exactly (multi-line raw)
  isArray: (name) =>
    ["Spec", "Skill", "Gem", "Item", "Slot", "PlayerStat", "ItemSet", "SkillSet", "Socket"].includes(
      name,
    ),
});

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseNodeList(s: unknown): number[] {
  if (typeof s !== "string" || s.length === 0) return [];
  return s
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
}

function firstMatch(lines: string[], re: RegExp): string | undefined {
  for (const l of lines) {
    const m = l.match(re);
    if (m && m[1] !== undefined) return m[1].trim();
  }
  return undefined;
}

// Heuristic until we wire the gem DB: PoB support gem skillIds tend to start
// with "Support". TODO: resolve against repoe-fork Gems.json for accuracy.
function looksLikeSupport(g: Record<string, unknown>): boolean {
  const skillId = String(g["@_skillId"] ?? "");
  return skillId.startsWith("Support") || g["@_isSupport"] === "true";
}

/** Parse a decoded PoB XML string into a structured PobBuild. */
export function parsePobXml(xml: string): PobBuild {
  const doc = parser.parse(xml);
  const isPoE2 = doc.PathOfBuilding2 !== undefined;
  const root = doc.PathOfBuilding2 ?? doc.PathOfBuilding;
  if (!root) {
    throw new Error("Not a Path of Building build (missing <PathOfBuilding2> root element)");
  }
  const build = root.Build ?? {};

  // --- Trees -------------------------------------------------------------
  const treeRoot = root.Tree ?? {};
  const specs: Record<string, unknown>[] = treeRoot.Spec ?? [];
  const trees: TreeSpec[] = specs.map((s) => ({
    title: s["@_title"] as string | undefined,
    treeVersion: String(s["@_treeVersion"] ?? ""),
    classId: num(s["@_classId"]),
    ascendClassId: num(s["@_ascendClassId"]),
    secondaryAscendClassId:
      s["@_secondaryAscendClassId"] != null ? num(s["@_secondaryAscendClassId"]) : undefined,
    nodes: parseNodeList(s["@_nodes"]),
  }));
  const activeSpec = num(treeRoot["@_activeSpec"], 1) - 1;
  const activeTreeIndex = activeSpec >= 0 && activeSpec < trees.length ? activeSpec : 0;

  // --- Skills ------------------------------------------------------------
  // PoB nests <Skills><SkillSet><Skill>...; tolerate a flat <Skills><Skill> too.
  const skillsRoot = root.Skills ?? {};
  const rawGroups: Record<string, unknown>[] = [];
  if (Array.isArray(skillsRoot.SkillSet)) {
    for (const set of skillsRoot.SkillSet) {
      const s = set as Record<string, unknown>;
      if (Array.isArray(s.Skill)) rawGroups.push(...(s.Skill as Record<string, unknown>[]));
    }
  } else if (Array.isArray(skillsRoot.Skill)) {
    rawGroups.push(...(skillsRoot.Skill as Record<string, unknown>[]));
  }
  const skills: SkillGroup[] = rawGroups.map((sk) => {
    const gemRows: Record<string, unknown>[] = (sk.Gem as Record<string, unknown>[]) ?? [];
    const gems: Gem[] = gemRows.map((g) => ({
      nameSpec: String(g["@_nameSpec"] ?? ""),
      skillId: g["@_skillId"] as string | undefined,
      gemId: g["@_gemId"] as string | undefined,
      level: num(g["@_level"], 1),
      quality: num(g["@_quality"]),
      enabled: g["@_enabled"] !== "false",
      isSupport: looksLikeSupport(g),
    }));
    return {
      label: sk["@_label"] as string | undefined,
      slot: sk["@_slot"] as string | undefined,
      mainActiveSkill: sk["@_mainActiveSkill"] != null ? num(sk["@_mainActiveSkill"]) : undefined,
      enabled: sk["@_enabled"] !== "false",
      gems,
    };
  });

  // --- Items + active slot mapping --------------------------------------
  const itemsRoot = root.Items ?? {};
  const rawItems: (Record<string, unknown> | string)[] = itemsRoot.Item ?? [];
  const items: Item[] = rawItems.map((it) => {
    const raw = (typeof it === "string" ? it : String(it["#text"] ?? "")).trim();
    const lines = raw.split(/\r?\n/);
    return {
      id: String(typeof it === "object" ? (it["@_id"] ?? "") : ""),
      raw,
      rarity: firstMatch(lines, /^Rarity:\s*(.+)$/i),
      // PoB item text is: "Rarity: X" / name / baseType / ...mods
      name: lines[1]?.trim() || undefined,
      baseType: lines[2]?.trim() || undefined,
    };
  });

  const slots: Record<string, string> = {};
  const itemSets: Record<string, unknown>[] = itemsRoot.ItemSet ?? [];
  const activeSetId = String(itemsRoot["@_activeItemSet"] ?? "");
  const activeSet =
    itemSets.find((s) => String(s["@_id"] ?? "") === activeSetId) ?? itemSets[0];
  const slotRows: Record<string, unknown>[] = (activeSet?.Slot as Record<string, unknown>[]) ?? [];
  for (const sl of slotRows) {
    const name = sl["@_name"] as string | undefined;
    const itemId = sl["@_itemId"];
    if (name && itemId != null) slots[name] = String(itemId);
  }

  // --- Cached stats baked into the code ---------------------------------
  const cachedStats: Record<string, number> = {};
  const statRows: Record<string, unknown>[] = (build.PlayerStat as Record<string, unknown>[]) ?? [];
  for (const ps of statRows) {
    const stat = ps["@_stat"] as string | undefined;
    const value = Number(ps["@_value"]);
    if (stat && Number.isFinite(value)) cachedStats[stat] = value;
  }

  return {
    isPoE2,
    level: num(build["@_level"], 1),
    className: String(build["@_className"] ?? ""),
    ascendClassName: String(build["@_ascendClassName"] ?? ""),
    mainSocketGroup: build["@_mainSocketGroup"] != null ? num(build["@_mainSocketGroup"]) : undefined,
    trees,
    activeTreeIndex,
    skills,
    items,
    slots,
    cachedStats,
    xml,
  };
}

/** Convenience: decode a code straight into a parsed build. */
export function parsePobCode(code: string): PobBuild {
  return parsePobXml(decodePobCode(code));
}
