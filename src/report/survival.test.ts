import { describe, it, expect } from "vitest";
import { analyzeSurvival } from "./survival.js";
import type { StatProfile } from "../types/buildspec.js";

// Build a StatProfile fixture. Pure function under test — no engine needed.
function profile(overrides: Partial<StatProfile> = {}): StatProfile {
  return {
    life: 2000,
    energyShield: 0,
    ward: 0,
    spirit: 100,
    spiritReserved: 0,
    armour: 0,
    evasion: 1500,
    blockChance: 0,
    resists: {
      Fire: { current: 75, total: 90, max: 75, overcap: 15, missing: 0 },
      Cold: { current: 75, total: 80, max: 75, overcap: 5, missing: 0 },
      Lightning: { current: 75, total: 76, max: 75, overcap: 1, missing: 0 },
      Chaos: { current: 10, total: 10, max: 75, overcap: 0, missing: 65 },
    },
    maxHitTaken: { Physical: 5000, Fire: 8000, Cold: 8000, Lightning: 8000, Chaos: 4000 },
    totalEHP: 12000,
    stunThreshold: 2000,
    raw: {},
    ...overrides,
  };
}

describe("analyzeSurvival", () => {
  it("flags an uncapped elemental resistance as critical", () => {
    const stats = profile({
      resists: {
        ...profile().resists,
        Fire: { current: 40, total: 40, max: 75, overcap: 0, missing: 35 },
      },
    });
    const guide = analyzeSurvival(stats, { level: 92, ascendancy: "Deadeye" });
    const fire = guide.gaps.find((g) => g.stat === "FireResist");
    expect(fire?.severity).toBe("critical");
    expect(guide.summary).toMatch(/critical/);
    // critical issues surface first in the path
    expect(guide.path[0]?.description).toMatch(/Fire resistance to 75%/);
  });

  it("treats a small resistance shortfall as a warning, not critical", () => {
    const stats = profile({
      resists: {
        ...profile().resists,
        Lightning: { current: 65, total: 65, max: 75, overcap: 0, missing: 10 },
      },
    });
    const lr = analyzeSurvival(stats).gaps.find((g) => g.stat === "LightningResist");
    expect(lr?.severity).toBe("warn");
  });

  it("warns on near-full Spirit reservation", () => {
    const guide = analyzeSurvival(profile({ spirit: 364, spiritReserved: 347 }));
    const spirit = guide.gaps.find((g) => g.stat === "Spirit");
    expect(spirit?.severity).toBe("warn");
    expect(spirit?.note).toMatch(/95%|9[0-9]%/);
  });

  it("flags low eHP for high level as critical", () => {
    const guide = analyzeSurvival(profile({ totalEHP: 4000 }), { level: 95 });
    const ehp = guide.gaps.find((g) => g.stat === "TotalEHP");
    expect(ehp?.severity).toBe("critical");
  });

  it("identifies the weakest damage type", () => {
    const guide = analyzeSurvival(profile()); // Chaos max-hit 4000 is lowest
    const weak = guide.gaps.find((g) => g.stat.endsWith("MaximumHitTaken"));
    expect(weak?.stat).toBe("ChaosMaximumHitTaken");
  });

  it("warns when there is no mitigation layer", () => {
    const guide = analyzeSurvival(
      profile({ armour: 0, evasion: 0, blockChance: 0, energyShield: 0, ward: 0 }),
    );
    expect(guide.gaps.some((g) => g.stat === "DefensiveLayers")).toBe(true);
  });

  it("reports solid survivability when everything is capped and healthy", () => {
    const guide = analyzeSurvival(
      profile({
        resists: {
          Fire: { current: 75, total: 75, max: 75, overcap: 0, missing: 0 },
          Cold: { current: 75, total: 75, max: 75, overcap: 0, missing: 0 },
          Lightning: { current: 75, total: 75, max: 75, overcap: 0, missing: 0 },
          Chaos: { current: 30, total: 30, max: 75, overcap: 0, missing: 45 },
        },
      }),
      { level: 95 },
    );
    expect(guide.gaps.some((g) => g.severity === "critical")).toBe(false);
  });
});
