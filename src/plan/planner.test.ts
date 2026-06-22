import { describe, it, expect } from "vitest";
import { planPath } from "./planner.js";
import { parsePobXml, encodePobCode } from "../ingest/pobcode.js";
import { pobBuildToBuildSpec } from "../ingest/buildspec.js";
import type { CorpusBuild, MatchResult } from "../types/buildspec.js";

const USER_XML = `<PathOfBuilding2>
  <Build level="90" className="Sorceress" ascendClassName="Stormweaver" mainSocketGroup="1"/>
  <Skills><SkillSet>
    <Skill enabled="true"><Gem nameSpec="Spark" skillId="Spark" level="20" quality="0" enabled="true"/></Skill>
  </SkillSet></Skills>
  <Tree activeSpec="1"><Spec treeVersion="0_5" classId="0" ascendClassId="1" nodes="1,2,3"/></Tree>
  <Items activeItemSet="1">
    <Item id="1">Rarity: UNIQUE
Item A
Base</Item>
    <ItemSet id="1"><Slot name="Weapon 1" itemId="1"/></ItemSet>
  </Items>
</PathOfBuilding2>`;

const TARGET_XML = `<PathOfBuilding2>
  <Build level="94" className="Sorceress" ascendClassName="Stormweaver" mainSocketGroup="1"/>
  <Skills><SkillSet>
    <Skill enabled="true">
      <Gem nameSpec="Comet" skillId="Comet" level="20" quality="0" enabled="true"/>
      <Gem nameSpec="Lightning Infusion" skillId="SupportLightningInfusion" level="1" quality="0" enabled="true"/>
    </Skill>
    <Skill enabled="true"><Gem nameSpec="Spark" skillId="Spark" level="20" quality="0" enabled="true"/></Skill>
  </SkillSet></Skills>
  <Tree activeSpec="1"><Spec treeVersion="0_5" classId="0" ascendClassId="1" nodes="2,3,4,5"/></Tree>
  <Items activeItemSet="1">
    <Item id="1">Rarity: UNIQUE
Item A
Base</Item>
    <Item id="2">Rarity: UNIQUE
Item B
Base</Item>
    <ItemSet id="1"><Slot name="Weapon 1" itemId="1"/><Slot name="Body Armour" itemId="2"/></ItemSet>
  </Items>
</PathOfBuilding2>`;

function targetCorpusBuild(): CorpusBuild {
  const pobCode = encodePobCode(TARGET_XML);
  const spec = pobBuildToBuildSpec(parsePobXml(TARGET_XML), "pobarchives", "t", { pobCode });
  return { ...spec, sourceUrl: "https://pobarchives.com/build/t" } as CorpusBuild;
}

describe("planPath", () => {
  const user = parsePobXml(USER_XML);
  const match: MatchResult = {
    target: targetCorpusBuild(),
    score: 0.5,
    reasons: ["same ascendancy (Stormweaver)"],
  };
  const plan = planPath(user, match);

  it("computes the passive-tree delta by node set", () => {
    expect(plan.treeToAllocate).toBe(2); // nodes 4,5
    expect(plan.treeToRefund).toBe(1); // node 1
  });

  it("identifies active skills the target uses that the user lacks", () => {
    expect(plan.skillsToAcquire).toContain("Comet");
    expect(plan.skillsToAcquire).not.toContain("Spark"); // user already has it
  });

  it("identifies support gems to add", () => {
    expect(plan.supportsToAdd).toContain("Lightning Infusion");
  });

  it("identifies uniques to buy", () => {
    expect(plan.uniquesToBuy).toEqual(["Item B"]);
  });

  it("produces ordered steps covering skill, items, supports, and tree", () => {
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("gem");
    expect(kinds).toContain("item");
    expect(kinds).toContain("passive");
    // main-skill step comes before the tree re-spec
    expect(kinds.indexOf("gem")).toBeLessThan(kinds.lastIndexOf("passive"));
  });
});
