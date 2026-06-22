import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeStatsFromXml, engineAvailable } from "./pob.js";

// Integration test: drives the real headless PoB2 engine via LuaJIT. Skipped
// automatically when the engine isn't present (no LuaJIT / no vendored PoB),
// so clean checkouts and CI stay green.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const available = engineAvailable();

describe("pob engine (integration)", () => {
  it.skipIf(!available)(
    "boots PoB2 headless and returns a populated StatProfile",
    () => {
      const xml = readFileSync(join(repoRoot, "fixtures", "example.xml"), "utf8");
      const r = computeStatsFromXml(xml);

      expect(r.ok).toBe(true);
      expect(r.rawCount).toBeGreaterThan(100);
      // PoE2 characters start with a Spirit pool of 100.
      expect(r.stats.spirit).toBeGreaterThan(0);
      // Resistance profile is structured (current/max/overcap derived correctly).
      const fire = r.stats.resists.Fire;
      expect(fire).toBeDefined();
      expect(fire!.max).toBe(75); // default elemental cap
      // Stun threshold is a real number (PoE2 first-class defensive stat).
      expect(typeof r.stats.stunThreshold).toBe("number");
      // raw passthrough carries the full engine output.
      expect(Object.keys(r.stats.raw).length).toBe(r.rawCount);
    },
    120_000,
  );

  it.runIf(!available)("is reported unavailable when LuaJIT/PoB are missing", () => {
    expect(available).toBe(false);
  });
});
