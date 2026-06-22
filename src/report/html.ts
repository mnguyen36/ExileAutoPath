// Render a full plan report as a standalone HTML file you can open in a browser.
// Self-contained (inline CSS, no assets) so it works by double-clicking the file.

import type {
  StatProfile,
  SurvivalGuide,
  BuildPath,
  GapSeverity,
  ResistProfile,
} from "../types/buildspec.js";

export interface PlanReportData {
  user: { className: string; ascendancy: string; mainSkill: string; level: number };
  stats?: StatProfile;
  path?: BuildPath;
  guide?: SurvivalGuide;
  generatedAt?: string;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const fmt = (n: number | undefined, d = 0): string =>
  n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d });

function statCard(label: string, value: string, hint = ""): string {
  return `<div class="card"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${
    hint ? `<div class="h">${esc(hint)}</div>` : ""
  }</div>`;
}

function resistChip(name: string, r: ResistProfile): string {
  const under = r.current < r.max;
  const cls = under ? "res under" : r.overcap > 0 ? "res over" : "res ok";
  const extra = under ? ` (−${r.max - r.current})` : r.overcap > 0 ? ` (+${r.overcap})` : "";
  return `<span class="${cls}">${esc(name)} ${r.current}/${r.max}${extra}</span>`;
}

function statsSection(s: StatProfile): string {
  const cards = [
    statCard("Total DPS", fmt(s.totalDPS)),
    statCard("Life", fmt(s.life)),
    statCard("Energy Shield", fmt(s.energyShield)),
    statCard("Ward", fmt(s.ward)),
    statCard("Mana", fmt(s.mana)),
    statCard("Spirit", `${fmt(s.spirit)}`, `${fmt(s.spiritReserved)} reserved`),
    statCard("Armour", fmt(s.armour)),
    statCard("Evasion", fmt(s.evasion)),
    statCard("Block", `${fmt(s.blockChance)}%`),
    statCard("Total eHP", fmt(s.totalEHP)),
    statCard("Stun threshold", fmt(s.stunThreshold)),
  ].join("");
  const resists = (["Fire", "Cold", "Lightning", "Chaos"] as const)
    .map((el) => {
      const r = s.resists[el];
      return r ? resistChip(el, r) : "";
    })
    .filter(Boolean)
    .join(" ");
  const hits = Object.entries(s.maxHitTaken)
    .map(([t, v]) => `<span class="res ok">${esc(t)} ${fmt(v)}</span>`)
    .join(" ");
  return `<section><h2>Stats <span class="src">via headless Path of Building 2</span></h2>
    <div class="grid">${cards}</div>
    <div class="row"><span class="lbl">Resistances</span> ${resists}</div>
    <div class="row"><span class="lbl">Max hit taken</span> ${hits}</div>
  </section>`;
}

function pathSection(p: BuildPath): string {
  const t = p.target;
  const steps = p.steps.length
    ? `<ol>${p.steps.map((s) => `<li><span class="kind ${s.kind}">${s.kind}</span> ${esc(s.description)}</li>`).join("")}</ol>`
    : `<p class="muted">Already aligned with the target.</p>`;
  const link = t.sourceUrl ? `<a href="${esc(t.sourceUrl)}" target="_blank">${esc(t.sourceUrl)}</a>` : "";
  return `<section><h2>Closest build &amp; path</h2>
    <div class="target">
      <div class="match">${Math.round(p.matchScore * 100)}%</div>
      <div>
        <div class="tname">${esc(t.ascendancy || t.className)} / ${esc(t.mainSkill || "?")} <span class="muted">${t.level > 0 ? `L${esc(t.level)}` : "endgame"}</span></div>
        <div class="why">${esc(p.matchReasons.join("; "))}</div>
        <div class="link">${link}</div>
      </div>
    </div>
    <h3>Path to this build</h3>
    ${steps}
  </section>`;
}

const SEV_LABEL: Record<GapSeverity, string> = { critical: "critical", warn: "watch", ok: "ok" };

function guideSection(g: SurvivalGuide): string {
  const gaps = g.gaps
    .map((gap) => `<li class="gap ${gap.severity}"><span class="badge">${SEV_LABEL[gap.severity]}</span> ${esc(gap.note)}</li>`)
    .join("");
  const ups = g.path.length
    ? `<h3>Suggested next upgrades</h3><ol>${g.path.map((s) => `<li>${esc(s.description)}</li>`).join("")}</ol>`
    : "";
  return `<section><h2>Survivability</h2>
    <p class="summary">${esc(g.summary)}</p>
    <ul class="gaps">${gaps}</ul>
    ${ups}
  </section>`;
}

export function renderPlanHtml(data: PlanReportData): string {
  const u = data.user;
  const who = `${esc(u.className)}${u.ascendancy ? ` (${esc(u.ascendancy)})` : ""} / ${esc(u.mainSkill || "?")}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ExileAutoPath — ${who}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif; background:#13151a; color:#e7e3d6; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 20px 64px; }
  header h1 { margin:0 0 2px; font-size:22px; color:#caa85a; }
  header .sub { color:#9a958a; font-size:13px; }
  section { background:#1b1e26; border:1px solid #2a2e39; border-radius:10px; padding:18px 20px; margin-top:18px; }
  h2 { margin:0 0 14px; font-size:16px; color:#caa85a; }
  h2 .src { font-size:11px; color:#7c776c; font-weight:400; }
  h3 { margin:18px 0 8px; font-size:14px; color:#c6c0b0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
  .card { background:#23262f; border:1px solid #30343f; border-radius:8px; padding:10px 12px; }
  .card .k { font-size:11px; color:#8a857a; text-transform:uppercase; letter-spacing:.04em; }
  .card .v { font-size:19px; font-weight:600; color:#f0ece0; }
  .card .h { font-size:11px; color:#8a857a; }
  .row { margin-top:12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .row .lbl { font-size:12px; color:#8a857a; width:110px; }
  .res { font-size:12px; padding:2px 8px; border-radius:20px; background:#23262f; border:1px solid #30343f; }
  .res.under { background:#3a1e1e; border-color:#7a3a3a; color:#ffb3b3; }
  .res.over { color:#b8c9a8; }
  .target { display:flex; gap:16px; align-items:center; }
  .match { font-size:30px; font-weight:700; color:#caa85a; min-width:74px; text-align:center; }
  .tname { font-size:16px; font-weight:600; }
  .why, .link { font-size:12px; color:#9a958a; }
  .link a { color:#6fa8d6; }
  ol, ul { margin:6px 0; padding-left:22px; }
  li { margin:5px 0; }
  .kind { font-size:10px; text-transform:uppercase; letter-spacing:.04em; padding:1px 6px; border-radius:4px; background:#30343f; color:#bdb7a8; margin-right:4px; }
  .kind.gem{background:#243a2f;color:#9fe0bd}.kind.item{background:#3a3324;color:#e6cf94}.kind.passive{background:#2a2e44;color:#a9b6ee}.kind.config{background:#33293a;color:#d8a9ee}
  .gaps { list-style:none; padding-left:0; }
  .gap { padding:7px 10px; border-radius:7px; margin:5px 0; background:#23262f; border-left:3px solid #4a4e59; }
  .gap.critical { border-left-color:#d05656; background:#2e1d1d; }
  .gap.warn { border-left-color:#caa85a; background:#2a261a; }
  .gap .badge { font-size:10px; text-transform:uppercase; color:#cbb; margin-right:6px; }
  .gap.critical .badge { color:#ff9b9b; } .gap.warn .badge { color:#e6cf94; }
  .summary { color:#c6c0b0; } .muted { color:#8a857a; } .footer { margin-top:24px; font-size:11px; color:#6b665c; text-align:center; }
</style></head><body><div class="wrap">
  <header>
    <h1>ExileAutoPath</h1>
    <div class="sub">${who} — level ${esc(u.level)}${data.generatedAt ? ` · ${esc(data.generatedAt)}` : ""}</div>
  </header>
  ${data.stats ? statsSection(data.stats) : ""}
  ${data.path ? pathSection(data.path) : ""}
  ${data.guide ? guideSection(data.guide) : ""}
  <div class="footer">Generated by ExileAutoPath · stats computed with Path of Building 2 (headless)</div>
</div></body></html>`;
}
