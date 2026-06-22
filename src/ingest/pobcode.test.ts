import { describe, it, expect } from "vitest";
import { decodePobCode, encodePobCode, parsePobXml, parsePobCode } from "./pobcode.js";

// A small but structurally-representative PoB2 build document. Validates the
// codec + parser deterministically without network. TODO: add a real-world
// PoB2 export under fixtures/ once the engine spike produces one.
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding2>
  <Build level="92" className="Ranger" ascendClassName="Deadeye" mainSocketGroup="1">
    <PlayerStat stat="Life" value="3120"/>
    <PlayerStat stat="TotalDPS" value="845210.5"/>
  </Build>
  <Skills>
    <SkillSet>
      <Skill mainActiveSkill="1" enabled="true">
        <Gem nameSpec="Lightning Arrow" skillId="LightningArrow" level="20" quality="20" enabled="true"/>
        <Gem nameSpec="Martial Tempo" skillId="SupportMartialTempo" level="1" quality="0" enabled="true"/>
      </Skill>
    </SkillSet>
  </Skills>
  <Tree activeSpec="1">
    <Spec title="Default" treeVersion="0_5" classId="3" ascendClassId="1" nodes="123,456,789"/>
  </Tree>
  <Items activeItemSet="1">
    <Item id="1">Rarity: UNIQUE
Quill Rain
Short Bow</Item>
    <ItemSet id="1">
      <Slot name="Weapon 1" itemId="1"/>
    </ItemSet>
  </Items>
</PathOfBuilding2>`;

describe("pob code codec", () => {
  it("round-trips xml through encode/decode", () => {
    const code = encodePobCode(SAMPLE_XML);
    expect(code).not.toMatch(/[+/]/); // url-safe alphabet only
    expect(decodePobCode(code)).toBe(SAMPLE_XML);
  });

  it("tolerates wrapped/whitespaced codes when decoding", () => {
    const code = encodePobCode(SAMPLE_XML);
    const wrapped = code.replace(/(.{40})/g, "$1\n"); // simulate a pasted, line-wrapped code
    expect(decodePobCode(wrapped)).toBe(SAMPLE_XML);
  });
});

describe("pob xml parser", () => {
  const build = parsePobXml(SAMPLE_XML);

  it("reads the build header", () => {
    expect(build.className).toBe("Ranger");
    expect(build.ascendClassName).toBe("Deadeye");
    expect(build.level).toBe(92);
    expect(build.mainSocketGroup).toBe(1);
  });

  it("reads the active tree and node list", () => {
    expect(build.trees).toHaveLength(1);
    expect(build.activeTreeIndex).toBe(0);
    expect(build.trees[0]?.treeVersion).toBe("0_5");
    expect(build.trees[0]?.nodes).toEqual([123, 456, 789]);
  });

  it("reads skill groups and flags supports", () => {
    expect(build.skills[0]?.gems[0]?.nameSpec).toBe("Lightning Arrow");
    expect(build.skills[0]?.gems[0]?.isSupport).toBe(false);
    expect(build.skills[0]?.gems[1]?.isSupport).toBe(true);
  });

  it("reads items and the active slot mapping", () => {
    expect(build.items[0]?.name).toBe("Quill Rain");
    expect(build.items[0]?.baseType).toBe("Short Bow");
    expect(build.slots["Weapon 1"]).toBe("1");
  });

  it("captures cached PlayerStat values", () => {
    expect(build.cachedStats.Life).toBe(3120);
    expect(build.cachedStats.TotalDPS).toBeCloseTo(845210.5);
  });

  it("throws on non-PoB input", () => {
    expect(() => parsePobXml("<html></html>")).toThrow(/Path of Building/);
  });
});

describe("parsePobCode end-to-end", () => {
  it("decodes and parses in one step", () => {
    const build = parsePobCode(encodePobCode(SAMPLE_XML));
    expect(build.className).toBe("Ranger");
    expect(build.trees[0]?.nodes.length).toBe(3);
  });
});
