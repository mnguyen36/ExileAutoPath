import { describe, it, expect } from "vitest";
import { scoreMatch, matchBuilds } from "./matcher.js";
import type { BuildSpec, CorpusBuild } from "../types/buildspec.js";

function spec(o: Partial<BuildSpec> = {}): BuildSpec {
  return {
    source: "user",
    id: "u",
    className: "Sorceress",
    ascendancy: "Stormweaver",
    mainSkill: "Spark",
    weaponType: "Sceptre",
    keyUniques: ["The Eternal Spark"],
    keystones: [],
    notables: [],
    treeNodes: [1, 2, 3, 4, 5, 6, 7, 8],
    level: 90,
    ...o,
  };
}
function corpus(o: Partial<CorpusBuild>): CorpusBuild {
  return { ...spec(), source: "pobarchives" as never, ...o } as CorpusBuild;
}

describe("scoreMatch", () => {
  it("scores an identical build at ~1.0", () => {
    const r = scoreMatch(spec(), corpus({ id: "same" }));
    expect(r.score).toBeGreaterThan(0.99);
  });

  it("same class but different ascendancy scores well below same ascendancy", () => {
    const sameAsc = scoreMatch(spec(), corpus({ id: "a" }));
    const diffAsc = scoreMatch(
      spec(),
      corpus({ id: "b", ascendancy: "Chronomancer", mainSkill: "Cold Snap", treeNodes: [9, 10] }),
    );
    expect(diffAsc.score).toBeLessThan(sameAsc.score);
    expect(diffAsc.reasons.join(" ")).toMatch(/same class/);
  });

  it("rewards passive-tree overlap", () => {
    const high = scoreMatch(spec(), corpus({ id: "h", treeNodes: [1, 2, 3, 4, 5, 6, 7, 8] }));
    const low = scoreMatch(spec(), corpus({ id: "l", treeNodes: [1, 99, 98, 97] }));
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.reasons.some((r) => /passive-tree overlap/.test(r))).toBe(true);
  });

  it("recognizes related (substring) main skills", () => {
    const r = scoreMatch(spec({ mainSkill: "Spark" }), corpus({ id: "s", mainSkill: "Spark of Storms" }));
    expect(r.reasons.join(" ")).toMatch(/related main skill/);
  });
});

describe("matchBuilds", () => {
  it("returns targets ranked best-first and respects topN", () => {
    const userBuild = spec();
    const c: CorpusBuild[] = [
      corpus({ id: "far", ascendancy: "Deadeye", className: "Ranger", mainSkill: "Ice Shot", treeNodes: [50, 51] }),
      corpus({ id: "exact" }),
      corpus({ id: "near", mainSkill: "Spark of Storms", treeNodes: [1, 2, 3, 4, 90] }),
    ];
    const ranked = matchBuilds(userBuild, c, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.target.id).toBe("exact");
    expect(ranked[1]?.target.id).toBe("near");
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
  });
});
