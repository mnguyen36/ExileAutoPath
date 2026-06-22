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
import type { CorpusBuild } from "../types/buildspec.js";

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
  inflight++;
  try {
    const result = await analyze({ code: body.code, xml: body.xml }, corpus, { topN: 3 });
    const html = renderPlanHtml({
      user: result.user,
      stats: result.stats,
      matches: result.matches,
      path: result.path,
      guide: result.guide,
    });
    return {
      ok: true,
      league,
      corpusSize: corpus.length,
      user: result.user,
      engineError: result.engineError,
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
