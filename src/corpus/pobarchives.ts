// Corpus source: pobarchives.com -> pobb.in PoB2 codes.
//
// pobarchives is curl-friendly (no Cloudflare JS challenge, unlike mobalytics /
// poe.ninja) and every build page links a pobb.in code. We use it purely for
// DISCOVERY: list build ids, resolve each to its pobb.in code, fetch the raw
// code, then decode it locally — all real build data comes from the PoB code,
// not from scraping pobarchives' markup.

import type { CorpusBuild } from "../types/buildspec.js";
import { parsePobCode } from "../ingest/pobcode.js";
import { pobBuildToBuildSpec } from "../ingest/buildspec.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Extract unique pobarchives build ids from a listing page's HTML. (Pure.) */
export function extractBuildIds(html: string, limit = 30): string[] {
  const ids = [...html.matchAll(/\/build\/([A-Za-z0-9_-]{6,})/g)].map((m) => m[1]!);
  return [...new Set(ids)].slice(0, limit);
}

/** Extract the pobb.in code id referenced by a pobarchives build page. (Pure.)
 *  Pages can contain truncated/display references, so pick the longest match
 *  (ties broken by frequency) — real pobb.in ids are ~11-12 chars. */
export function extractPobbinId(html: string): string | null {
  const ids = [...html.matchAll(/pobb\.in\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  if (ids.length === 0) return null;
  const freq = new Map<string, number>();
  for (const id of ids) freq.set(id, (freq.get(id) ?? 0) + 1);
  return [...freq.keys()].sort((a, b) => b.length - a.length || freq.get(b)! - freq.get(a)!)[0]!;
}

/** True if a fetched body looks like a real PoB code rather than an HTML page. */
export function looksLikeCode(body: string): boolean {
  const t = body.trim();
  return t.length > 200 && !t.includes("<") && /^[A-Za-z0-9_-]+$/.test(t.slice(0, 200));
}

export async function discoverBuildIds(game = "poe2", limit = 30): Promise<string[]> {
  return extractBuildIds(await fetchText(`https://pobarchives.com/?game=${encodeURIComponent(game)}`), limit);
}

/** Resolve a pobarchives build id to its raw PoB2 code (or null). */
export async function fetchCodeForBuild(buildId: string): Promise<string | null> {
  const pobbinId = extractPobbinId(await fetchText(`https://pobarchives.com/build/${buildId}`));
  if (!pobbinId) return null;
  const code = await fetchText(`https://pobb.in/${pobbinId}/raw`);
  return looksLikeCode(code) ? code.trim() : null;
}

export interface BuildCorpusOptions {
  game?: string;
  league?: string;
  limit?: number; // target number of (PoE2) builds to collect
  scan?: number; // max candidate ids to examine (defaults to limit*4)
  delayMs?: number;
  poe2Only?: boolean; // keep only <PathOfBuilding2> builds (defaults true for game=poe2)
  onProgress?: (msg: string) => void;
}

/** Discover builds, fetch + decode their codes, return a corpus of BuildSpecs.
 *  The pobarchives listing mixes PoE1/PoE2, so we scan candidates and keep only
 *  PoE2 builds (by decoded root element) until we hit `limit`. */
export async function buildCorpus(opts: BuildCorpusOptions = {}): Promise<CorpusBuild[]> {
  const { game = "poe2", league, limit = 20, delayMs = 600, onProgress = () => {} } = opts;
  const poe2Only = opts.poe2Only ?? game === "poe2";
  const scan = opts.scan ?? Math.max(limit * 4, 40);

  const ids = await discoverBuildIds(game, scan);
  onProgress(`discovered ${ids.length} candidates; collecting up to ${limit}${poe2Only ? " PoE2" : ""} builds`);

  const out: CorpusBuild[] = [];
  for (let i = 0; i < ids.length && out.length < limit; i++) {
    const id = ids[i]!;
    const tag = `[${out.length + 1}/${limit} · scan ${i + 1}/${ids.length}] ${id}`;
    try {
      const code = await fetchCodeForBuild(id);
      if (!code) {
        onProgress(`${tag}: no usable code`);
      } else {
        const build = parsePobCode(code);
        if (poe2Only && !build.isPoE2) {
          onProgress(`${tag}: PoE1 build, skipped`);
        } else {
          const spec = pobBuildToBuildSpec(build, "pobarchives", id, { league, pobCode: code });
          out.push({ ...spec, sourceUrl: `https://pobarchives.com/build/${id}` });
          onProgress(`${tag}: ${spec.ascendancy || spec.className} / ${spec.mainSkill || "?"} (L${spec.level})`);
        }
      }
    } catch (e) {
      onProgress(`${tag}: error ${(e as Error).message}`);
    }
    if (i < ids.length - 1 && out.length < limit) await sleep(delayMs);
  }
  onProgress(`collected ${out.length} build${out.length === 1 ? "" : "s"}`);
  return out;
}
