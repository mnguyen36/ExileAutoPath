// Corpus source: mobalytics.gg PoE2 build guides.
//
// Mobalytics is behind Cloudflare's JS challenge, so we drive a real headless
// browser (Playwright, lazy-imported). Each build page embeds the full build in
// window.__PRELOADED_STATE__. When a ready-made `pobCode` is present we reuse it
// (full build, engine-able); otherwise we derive the BuildSpec straight from the
// endgame variant (tree node ids, main skill, uniques) — the guide2pob approach.
// Bonus over raw ladder sources: guides carry leveling/budget variants.

import type { CorpusBuild, BuildSpec } from "../types/buildspec.js";
import { parsePobCode } from "../ingest/pobcode.js";
import { pobBuildToBuildSpec, codeToBuildSpec } from "../ingest/buildspec.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// PoE2 ascendancy -> base class. Used to derive class/ascendancy from the build
// slug when there's no pobCode (mobalytics names builds e.g. "ice-shot-deadeye").
const ASCENDANCY_CLASS: Record<string, string> = {
  Titan: "Warrior",
  Warbringer: "Warrior",
  "Smith of Kitava": "Warrior",
  Infernalist: "Witch",
  "Blood Mage": "Witch",
  Lich: "Witch",
  Stormweaver: "Sorceress",
  Chronomancer: "Sorceress",
  "Disciple of Varashta": "Sorceress",
  Deadeye: "Ranger",
  Pathfinder: "Ranger",
  Invoker: "Monk",
  "Acolyte of Chayula": "Monk",
  "Martial Artist": "Monk",
  Witchhunter: "Mercenary",
  "Gemling Legionnaire": "Mercenary",
  Tactician: "Mercenary",
  Amazon: "Huntress",
  Ritualist: "Huntress",
  "Spirit Walker": "Huntress",
  Shaman: "Druid",
  Oracle: "Druid",
};
const CLASSES = ["Warrior", "Witch", "Sorceress", "Ranger", "Monk", "Mercenary", "Huntress", "Druid"];

function ascendancyFromSlug(slug: string): string {
  const s = slug.toLowerCase();
  // Longest names first so "gemling-legionnaire" wins over a bare "gemling", etc.
  const byLen = Object.keys(ASCENDANCY_CLASS).sort((a, b) => b.length - a.length);
  for (const asc of byLen) {
    const kebab = asc.toLowerCase().replace(/ /g, "-");
    if (s.includes(kebab) || s.includes(kebab.replace(/-/g, ""))) return asc;
  }
  // mobalytics often shortens "Gemling Legionnaire" to "gemling"
  if (s.includes("gemling")) return "Gemling Legionnaire";
  return "";
}

function classFromIcon(iconURL: string): string {
  const file = (iconURL.split("/").pop() ?? "").replace(/\.(webp|png)$/i, "");
  return CLASSES.find((c) => file.startsWith(c)) ?? "";
}

// Many slugs name the class even when they don't name the ascendancy
// (e.g. "twister-huntress-levelling" -> Huntress). Checked AFTER ascendancy so
// "witchhunter" resolves to Mercenary, not Witch.
function classFromSlug(slug: string): string {
  const s = slug.toLowerCase();
  return CLASSES.find((c) => s.includes(c.toLowerCase())) ?? "";
}

// Minimal Playwright surface we use (avoids a hard type dependency).
interface Pageish {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  $$eval<T>(sel: string, fn: (els: Element[]) => T): Promise<T>;
  mouse: { wheel(x: number, y: number): Promise<void> };
}
interface Contextish {
  newPage(): Promise<Pageish>;
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
}
interface Browserish {
  newContext(opts: { userAgent: string }): Promise<Contextish>;
  close(): Promise<void>;
}

async function withBrowser<T>(fn: (browser: Browserish) => Promise<T>): Promise<T> {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "Playwright is required for the mobalytics source. Install it:\n" +
        "  npm install -D playwright && npx playwright install chromium",
    );
  }
  const browser = (await chromium.launch({ headless: true })) as unknown as Browserish;
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

// A fresh context per build: mobalytics only injects __PRELOADED_STATE__ on a
// context's first navigation, so reusing one page across builds loses it.
async function inFreshContext<T>(browser: Browserish, fn: (page: Pageish) => Promise<T>): Promise<T> {
  const ctx = await browser.newContext({ userAgent: UA });
  // tsx/esbuild decorates named functions with a __name() helper absent in the
  // browser; shim it so serialized evaluate() callbacks run.
  await ctx.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
  try {
    return await fn(await ctx.newPage());
  } finally {
    await ctx.close();
  }
}

// The front page lists only a handful of builds, so also sweep the per-class
// listing pages to cover every class/ascendancy.
const LISTING_URLS = [
  "https://mobalytics.gg/poe-2/builds",
  ...["warrior", "witch", "sorceress", "ranger", "monk", "mercenary", "huntress", "druid"].map(
    (c) => `https://mobalytics.gg/poe-2/${c}-builds`,
  ),
];

async function collectSlugsFrom(page: Pageish, set: Set<string>, limit: number): Promise<void> {
  for (let i = 0; i < 4 && set.size < limit; i++) {
    const hrefs = await page.$$eval("a[href]", (els) => els.map((e) => e.getAttribute("href") || ""));
    for (const h of hrefs) {
      const m = h.match(/\/poe-2\/builds\/([a-z0-9][a-z0-9-]+)$/i);
      if (m && m[1]) set.add(m[1]);
    }
    await page.mouse.wheel(0, 6000);
    await page.waitForTimeout(900);
  }
}

/** Discover build slugs across the front page + per-class listings. */
export async function discoverBuildSlugs(browser: Browserish, limit = 40): Promise<string[]> {
  const found = new Set<string>();
  for (const url of LISTING_URLS) {
    if (found.size >= limit) break;
    try {
      await inFreshContext(browser, async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(3500);
        await collectSlugsFrom(page, found, limit);
      });
    } catch {
      // skip a listing page that fails to load
    }
  }
  return [...found].slice(0, limit);
}

interface RawBuild {
  name: string;
  pobCode: string | null;
  treeNodes: number[];
  mainSkill: string;
  allSkills: string[];
  mainGemIcon: string;
  uniques: string[];
}

/** Extract the endgame variant essentials (and pobCode if present) from a page. */
export async function fetchBuild(page: Pageish, slug: string): Promise<RawBuild | null> {
  await page.goto(`https://mobalytics.gg/poe-2/builds/${slug}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(5000);
  return page.evaluate(() => {
    const state = (window as unknown as { __PRELOADED_STATE__?: unknown }).__PRELOADED_STATE__;
    if (!state) return null;
    let doc: Record<string, unknown> | null = null;
    const seen = new Set<unknown>();
    (function walk(o: unknown) {
      if (!o || typeof o !== "object" || seen.has(o) || doc) return;
      seen.add(o);
      const rec = o as Record<string, unknown>;
      if (rec.buildVariants) {
        doc = rec;
        return;
      }
      for (const k of Object.keys(rec)) walk(rec[k]);
    })(state);
    if (!doc) return null;

    const bv = doc.buildVariants as { values?: unknown[] } | unknown[] | undefined;
    const variants = (Array.isArray(bv) ? bv : (bv?.values ?? [])) as Record<string, unknown>[];
    if (variants.length === 0) return null;
    const nodeCount = (v: Record<string, unknown>) =>
      (((v.passiveTree as any)?.mainTree?.selectedSlugs as unknown[]) ?? []).length;
    const v = [...variants].sort((a, b) => nodeCount(b) - nodeCount(a))[0]!;

    const slugs = (((v.passiveTree as any)?.mainTree?.selectedSlugs as string[]) ?? []) as string[];
    const treeNodes = slugs
      .map((s) => parseInt(String(s).replace(/^node-/, ""), 10))
      .filter((n) => Number.isFinite(n));

    const gems = (((v.skillGems as any)?.gems ?? []) as any[]) || [];
    const g0 = (gems[0]?.activeSkill ?? {}) as Record<string, unknown>;
    const allSkills = gems
      .map((g) => String(g?.activeSkill?.name ?? ""))
      .filter((n) => n.length > 0);
    const eq = (v.equipment as Record<string, any>) ?? {};
    const uniques: string[] = [];
    for (const k of Object.keys(eq)) {
      const slot = eq[k];
      if (!slot || typeof slot !== "object") continue;
      const u = slot.uniqueItem ?? slot.set1?.uniqueItem ?? slot.set2?.uniqueItem;
      if (u && u.name && u.isUnique !== false) uniques.push(String(u.name));
    }

    return {
      name: String(doc.name ?? doc.title ?? ""),
      pobCode: typeof doc.pobCode === "string" ? doc.pobCode : null,
      treeNodes,
      mainSkill: String(g0.name ?? ""),
      allSkills: [...new Set(allSkills)],
      mainGemIcon: String(g0.iconURL ?? ""),
      uniques: [...new Set(uniques)],
    };
  });
}

function rawToBuildSpec(raw: RawBuild, slug: string, league?: string): BuildSpec {
  // Prefer the ready-made pobCode (authoritative class/ascendancy/tree/skill),
  // but never drop a build if its code is missing or fails to decode — fall back
  // to the variant data we already extracted.
  if (raw.pobCode) {
    try {
      if (parsePobCode(raw.pobCode).isPoE2) {
        return codeToBuildSpec(raw.pobCode, "mobalytics", slug, league);
      }
    } catch {
      // bad/corrupt pobCode — derive from the variant instead
    }
  }
  const ascendancy = ascendancyFromSlug(slug);
  const className =
    (ascendancy ? ASCENDANCY_CLASS[ascendancy] : undefined) ??
    (classFromSlug(slug) || classFromIcon(raw.mainGemIcon));
  return {
    source: "mobalytics",
    id: slug,
    league,
    className,
    ascendancy,
    mainSkill: raw.mainSkill,
    allSkills: raw.allSkills,
    keyUniques: raw.uniques,
    keystones: [],
    notables: [],
    treeNodes: raw.treeNodes,
    level: 0, // unknown without a pobCode; endgame variant
    pobCode: undefined, // only carry a code that actually decoded (handled above)
  };
}

/** Resolve a single mobalytics build URL to a CorpusBuild (for the target override). */
export async function resolveMobalyticsBuild(url: string, league?: string): Promise<CorpusBuild | null> {
  const slug = url.match(/\/poe-2\/builds\/([a-z0-9][a-z0-9-]+)/i)?.[1];
  if (!slug) return null;
  return withBrowser(async (browser) => {
    const raw = await inFreshContext(browser, (page) => fetchBuild(page, slug));
    if (!raw || raw.treeNodes.length === 0) return null;
    const spec = rawToBuildSpec(raw, slug, league);
    return { ...spec, sourceUrl: `https://mobalytics.gg/poe-2/builds/${slug}` } as CorpusBuild;
  });
}

export interface MobalyticsCorpusOptions {
  league?: string;
  limit?: number;
  delayMs?: number;
  onProgress?: (msg: string) => void;
}

/** Build a corpus of PoE2 BuildSpecs from mobalytics build guides. */
export async function buildCorpusFromMobalytics(
  opts: MobalyticsCorpusOptions = {},
): Promise<CorpusBuild[]> {
  const { league, limit = 20, delayMs = 700, onProgress = () => {} } = opts;
  return withBrowser(async (browser) => {
    const slugs = await discoverBuildSlugs(browser, Math.max(limit * 3, limit + 20));
    onProgress(`discovered ${slugs.length} build slugs; collecting up to ${limit}`);

    const out: CorpusBuild[] = [];
    for (let i = 0; i < slugs.length && out.length < limit; i++) {
      const slug = slugs[i]!;
      const tag = `[${out.length + 1}/${limit} · ${i + 1}/${slugs.length}] ${slug}`;
      try {
        const raw = await inFreshContext(browser, (page) => fetchBuild(page, slug));
        if (!raw || raw.treeNodes.length === 0) {
          onProgress(`${tag}: no build data`);
        } else {
          const spec = rawToBuildSpec(raw, slug, league);
          out.push({ ...spec, sourceUrl: `https://mobalytics.gg/poe-2/builds/${slug}` });
          onProgress(
            `${tag}: ${spec.ascendancy || spec.className || "?"} / ${spec.mainSkill || "?"} (${spec.treeNodes.length} nodes${spec.pobCode ? ", pob" : ""})`,
          );
        }
      } catch (e) {
        onProgress(`${tag}: error ${(e as Error).message}`);
      }
      if (out.length < limit) await sleep(delayMs);
    }
    onProgress(`collected ${out.length} build${out.length === 1 ? "" : "s"}`);
    return out;
  });
}
