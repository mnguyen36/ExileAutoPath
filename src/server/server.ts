// ExileAutoPath web server (MVP).
//
// A thin HTTP layer over the shared analyze() pipeline: paste a PoB2 code (or
// upload a file) -> the same report the `plan` CLI produces, rendered in-browser.
// Corpora are pre-built on disk (data/corpus*.json) and loaded into memory; the
// server never scrapes. Engine work is async (non-blocking) and concurrency-capped.

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../app/analyze.js";
import { renderPlanHtml } from "../report/html.js";
import { engineAvailable } from "../engine/pob.js";
import { decodePobCode, parsePobXml } from "../ingest/pobcode.js";
import { pobBuildToBuildSpec } from "../ingest/buildspec.js";
import { resolveMobalyticsBuild } from "../corpus/mobalytics.js";
import type { CorpusBuild } from "../types/buildspec.js";

const TARGET_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Build a target CorpusBuild from a pasted PoB2 code/XML.
function codeTarget(input: string, url?: string): CorpusBuild {
  const isXml = input.trimStart().startsWith("<");
  const build = parsePobXml(isXml ? input : decodePobCode(input));
  if (!build.isPoE2) throw new Error("that isn't a Path of Building 2 (PoE2) build");
  const spec = pobBuildToBuildSpec(build, "user", "custom", { pobCode: isXml ? undefined : input.trim() });
  return { ...spec, sourceUrl: url } as CorpusBuild;
}

// Resolve a user-supplied target: a PoB2 code, a pobb.in link, or a mobalytics link.
async function resolveTarget(input: string): Promise<CorpusBuild> {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    const pobb = s.match(/pobb\.in\/([A-Za-z0-9_-]+)/i);
    if (pobb) {
      const res = await fetch(`https://pobb.in/${pobb[1]}/raw`, {
        headers: { "User-Agent": TARGET_UA },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`pobb.in returned ${res.status}`);
      const code = (await res.text()).trim();
      if (!code || code.includes("<")) throw new Error("couldn't read a PoB code from that pobb.in link");
      return codeTarget(code, s);
    }
    if (/mobalytics\.gg\/poe-2\/builds\//i.test(s)) {
      const cb = await resolveMobalyticsBuild(s);
      if (!cb) throw new Error("couldn't read that mobalytics build");
      return cb;
    }
    throw new Error("unsupported link — use a pobb.in or mobalytics build link, or paste a PoB2 code");
  }
  return codeTarget(s);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const PUBLIC_DIR = join(ROOT, "public");

// data/corpus.json -> "default"; data/corpus-<league>.json -> "<league>".
function loadCorpora(): Map<string, CorpusBuild[]> {
  const map = new Map<string, CorpusBuild[]>();
  if (!existsSync(DATA_DIR)) return map;
  for (const f of readdirSync(DATA_DIR)) {
    const m = f.match(/^corpus(?:-(.+))?\.json$/);
    if (!m) continue;
    try {
      map.set(m[1] ?? "default", JSON.parse(readFileSync(join(DATA_DIR, f), "utf8")) as CorpusBuild[]);
    } catch {
      // skip an unreadable corpus file
    }
  }
  return map;
}

const corpora = loadCorpora();

// Cap concurrent engine subprocesses (each ~1s of CPU).
const MAX_INFLIGHT = 3;
let inflight = 0;

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });

app.get("/api/health", async () => ({
  ok: true,
  engine: engineAvailable(),
  leagues: [...corpora.keys()],
}));

app.get("/api/leagues", async () => ({
  leagues: [...corpora.entries()].map(([name, builds]) => ({ name, builds: builds.length })),
}));

interface AnalyzeBody {
  code?: string;
  xml?: string;
  league?: string;
  target?: string; // optional: a build link / PoB code to plan toward instead of the #1 match
}

app.post("/api/analyze", async (req, reply) => {
  const body = (req.body ?? {}) as AnalyzeBody;
  if (!body.code && !body.xml) {
    reply.code(400);
    return { ok: false, error: "Provide a Path of Building 2 code (or XML)." };
  }
  const league = body.league && corpora.has(body.league) ? body.league : ([...corpora.keys()][0] ?? "default");
  const corpus = corpora.get(league) ?? [];

  if (inflight >= MAX_INFLIGHT) {
    reply.code(503);
    return { ok: false, error: "Server busy computing other builds — try again in a moment." };
  }
  let target: CorpusBuild | undefined;
  if (body.target && body.target.trim()) {
    try {
      target = await resolveTarget(body.target);
    } catch (e) {
      reply.code(400);
      return { ok: false, error: `Target build: ${(e as Error).message}.` };
    }
  }

  inflight++;
  try {
    const result = await analyze({ code: body.code, xml: body.xml }, corpus, { topN: 3, target });
    const html = renderPlanHtml({
      user: result.user,
      stats: result.stats,
      matches: result.matches,
      path: result.path,
      customTarget: result.customTarget,
      guide: result.guide,
    });
    return {
      ok: true,
      league,
      corpusSize: corpus.length,
      user: result.user,
      engineError: result.engineError,
      customTarget: result.customTarget,
      html,
      tree: { userNodes: result.userNodes, targetNodes: result.targetNodes },
    };
  } catch (e) {
    reply.code(400);
    return { ok: false, error: (e as Error).message };
  } finally {
    inflight--;
  }
});

const PORT = Number(process.env.PORT ?? 5173);
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`ExileAutoPath web app → http://127.0.0.1:${PORT}`);
console.log(`  engine:  ${engineAvailable() ? "ready" : "UNAVAILABLE (stats/survival disabled)"}`);
console.log(`  corpora: ${[...corpora.keys()].join(", ") || "(none — run: npm run cli -- corpus)"}`);
