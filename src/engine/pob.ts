// Headless Path of Building 2 stat engine.
//
// Spawns LuaJIT running src/engine/lua/headless_stats.lua against a vendored
// PathOfBuilding-PoE2 checkout, feeds it a build's XML, and parses the computed
// stats back into a StatProfile. We feed XML (decoded on the Node side) because
// HeadlessWrapper stubs Deflate/Inflate, so the engine can't decode codes itself.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePobCode } from "../ingest/pobcode.js";
import type {
  StatProfile,
  ResistProfile,
  ElementalResist,
  DamageType,
} from "../types/buildspec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Two up from src/engine (tsx) or dist/engine (built) -> repo root.
const REPO_ROOT = join(__dirname, "..", "..");
const LUA_BRIDGE = join(REPO_ROOT, "src", "engine", "lua", "headless_stats.lua");

// Discovered local LuaJIT (winget DEVCOM.LuaJIT); override with POB_LUAJIT.
const DEFAULT_LUAJIT = join(
  process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local",
  "Programs",
  "LuaJIT",
  "bin",
  "luajit.exe",
);
const DEFAULT_POB_SRC = join(REPO_ROOT, ".vendor", "PathOfBuilding-PoE2", "src");

export interface EngineConfig {
  luajitPath?: string;
  pobSrcDir?: string;
  timeoutMs?: number;
}

export interface EngineResult {
  ok: boolean;
  error?: string;
  stats: StatProfile;
  rawCount: number;
}

function resolveConfig(cfg: EngineConfig): Required<EngineConfig> {
  return {
    luajitPath: cfg.luajitPath ?? process.env.POB_LUAJIT ?? DEFAULT_LUAJIT,
    pobSrcDir: cfg.pobSrcDir ?? process.env.POB_SRC ?? DEFAULT_POB_SRC,
    timeoutMs: cfg.timeoutMs ?? 90_000,
  };
}

/** True if the engine can run here (LuaJIT present + vendored PoB checkout). */
export function engineAvailable(cfg: EngineConfig = {}): boolean {
  const { luajitPath, pobSrcDir } = resolveConfig(cfg);
  const luaOk = luajitPath === "luajit" || existsSync(luajitPath);
  return luaOk && existsSync(join(pobSrcDir, "HeadlessWrapper.lua"));
}

interface BridgePayload {
  ok: boolean;
  error?: string;
  statCount: number;
  stats: Record<string, number | boolean>;
}

/** Compute a StatProfile from a build's PoB2 XML. */
export function computeStatsFromXml(xml: string, cfg: EngineConfig = {}): EngineResult {
  const { luajitPath, pobSrcDir, timeoutMs } = resolveConfig(cfg);
  const tmp = mkdtempSync(join(tmpdir(), "exileautopath-"));
  const inPath = join(tmp, "build.xml");
  const outPath = join(tmp, "stats.json");
  try {
    writeFileSync(inPath, xml, "utf8");
    const res = spawnSync(luajitPath, [LUA_BRIDGE, inPath, outPath], {
      cwd: pobSrcDir,
      stdio: ["ignore", "pipe", "pipe"], // stdin closed so a failed boot's io.read() can't hang us
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.error) {
      const e = res.error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(`LuaJIT not found at "${luajitPath}". Install it or set POB_LUAJIT.`);
      }
      throw e;
    }
    let payload: BridgePayload;
    try {
      payload = JSON.parse(readFileSync(outPath, "utf8")) as BridgePayload;
    } catch {
      throw new Error(
        `PoB engine produced no parseable output.\n--- stdout ---\n${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}`,
      );
    }
    const raw: Record<string, number> = {};
    for (const [k, v] of Object.entries(payload.stats)) {
      if (typeof v === "number") raw[k] = v;
    }
    return {
      ok: payload.ok,
      error: payload.error,
      rawCount: Object.keys(raw).length, // numeric stats we expose (statCount also counts booleans)
      stats: toStatProfile(raw),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Compute a StatProfile from a PoB2 import code (decodes, then runs the engine). */
export function computeStatsFromCode(code: string, cfg: EngineConfig = {}): EngineResult {
  return computeStatsFromXml(decodePobCode(code), cfg);
}

const ELEMENTS: readonly ElementalResist[] = ["Fire", "Cold", "Lightning", "Chaos"];
const DAMAGE_TYPES: readonly DamageType[] = ["Physical", "Fire", "Cold", "Lightning", "Chaos"];

function toStatProfile(raw: Record<string, number>): StatProfile {
  const n = (k: string): number | undefined => (typeof raw[k] === "number" ? raw[k] : undefined);

  const resists: Partial<Record<ElementalResist, ResistProfile>> = {};
  for (const el of ELEMENTS) {
    const current = n(`${el}Resist`);
    if (current === undefined) continue;
    const total = n(`${el}ResistTotal`) ?? current;
    const overcap = n(`${el}ResistOverCap`) ?? 0;
    const missing = n(`Missing${el}Resist`) ?? 0;
    // max = current + missing holds whether under cap (missing = cap-current)
    // or capped (missing = 0, current = cap).
    resists[el] = { current, total, max: current + missing, overcap, missing };
  }

  const maxHitTaken: Partial<Record<DamageType, number>> = {};
  for (const t of DAMAGE_TYPES) {
    const v = n(`${t}MaximumHitTaken`);
    if (v !== undefined) maxHitTaken[t] = v;
  }

  return {
    totalDPS: n("TotalDPS") ?? n("CombinedDPS"),
    fullDPS: n("FullDPS"),
    life: n("Life"),
    energyShield: n("EnergyShield"),
    ward: n("Ward"),
    mana: n("Mana"),
    spirit: n("Spirit"),
    spiritReserved: n("SpiritReserved"),
    armour: n("Armour"),
    evasion: n("Evasion"),
    blockChance: n("BlockChance"),
    resists,
    maxHitTaken,
    totalEHP: n("TotalEHP"),
    stunThreshold: n("StunThreshold"),
    raw,
  };
}
