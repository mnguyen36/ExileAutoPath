// Survival guide / gap analyzer.
//
// Takes a computed StatProfile and produces a SurvivalGuide: which stats are
// weak (uncapped resistances, low eHP for the level, over-reserved Spirit, no
// mitigation layer) plus preliminary gap-driven upgrade steps. This runs on a
// single build with no corpus; the full "closest meta build" path comes later
// (match -> plan) and will refine these steps with real targets.

import type {
  StatProfile,
  SurvivalGuide,
  StatGap,
  GapSeverity,
  UpgradeStep,
} from "../types/buildspec.js";

export interface SurvivalContext {
  level?: number;
  className?: string;
  ascendancy?: string;
}

// Heuristic effective-HP thresholds by level band. Deliberately rough and
// clearly approximate until we can compare against matched meta builds.
function ehpThresholds(level: number): { warn: number; critical: number } {
  if (level >= 90) return { critical: 6000, warn: 11000 };
  if (level >= 75) return { critical: 4000, warn: 8000 };
  if (level >= 60) return { critical: 2500, warn: 5000 };
  return { critical: 1200, warn: 3000 };
}

const SEVERITY_ORDER: Record<GapSeverity, number> = { critical: 0, warn: 1, ok: 2 };

export function analyzeSurvival(stats: StatProfile, ctx: SurvivalContext = {}): SurvivalGuide {
  const gaps: StatGap[] = [];
  const level = ctx.level ?? 1;

  // 1. Elemental resistances — should be capped. Endgame applies ~-60% ele
  //    penalty, so "below cap" is the common, dangerous case.
  for (const el of ["Fire", "Cold", "Lightning"] as const) {
    const r = stats.resists[el];
    if (!r) continue;
    if (r.missing > 0) {
      gaps.push({
        stat: `${el}Resist`,
        current: r.current,
        target: r.max,
        severity: r.missing >= 25 ? "critical" : "warn",
        note: `${el} resistance ${r.current}% is ${r.missing}% below the ${r.max}% cap.`,
      });
    } else if (r.overcap >= 20) {
      gaps.push({
        stat: `${el}Resist`,
        current: r.current,
        target: r.max,
        severity: "ok",
        note: `${el} resistance overcapped by ${r.overcap}% (minor waste; buffer vs resistance-reduction maps).`,
      });
    }
  }

  // Chaos resistance — hard to cap; negative is the real danger (bypasses ele
  // mitigations, and ES takes double from chaos).
  const chaos = stats.resists.Chaos;
  if (chaos) {
    if (chaos.current < 0) {
      gaps.push({
        stat: "ChaosResist",
        current: chaos.current,
        severity: chaos.current <= -30 ? "critical" : "warn",
        note: `Chaos resistance is negative (${chaos.current}%). Chaos hits and poison bypass ele mitigation; ES takes 2x chaos.`,
      });
    } else if (chaos.missing > 0) {
      gaps.push({
        stat: "ChaosResist",
        current: chaos.current,
        target: chaos.max,
        severity: "warn",
        note: `Chaos resistance ${chaos.current}% is below the ${chaos.max}% cap (chaos is hard to cap; positive is the goal).`,
      });
    }
  }

  // 2. Effective HP and the weakest damage type.
  const ehp = stats.totalEHP;
  if (ehp !== undefined) {
    const t = ehpThresholds(level);
    const severity: GapSeverity = ehp < t.critical ? "critical" : ehp < t.warn ? "warn" : "ok";
    gaps.push({
      stat: "TotalEHP",
      current: Math.round(ehp),
      target: t.warn,
      severity,
      note:
        severity === "ok"
          ? `Effective HP ~${Math.round(ehp)} is healthy for level ${level}.`
          : `Effective HP ~${Math.round(ehp)} is ${severity === "critical" ? "dangerously " : ""}low for level ${level} (aim for ~${t.warn}+).`,
    });
  }
  const hits = Object.entries(stats.maxHitTaken).sort((a, b) => a[1] - b[1]);
  const weakest = hits[0];
  if (weakest) {
    gaps.push({
      stat: `${weakest[0]}MaximumHitTaken`,
      current: Math.round(weakest[1]),
      severity: "ok",
      note: `Most fragile to ${weakest[0]} hits — largest survivable hit ~${Math.round(weakest[1])}.`,
    });
  }

  // 3. Spirit budget (a hard reservation cap in PoE2).
  if (stats.spirit !== undefined && stats.spirit > 0) {
    const reserved = stats.spiritReserved ?? 0;
    const pct = reserved / stats.spirit;
    if (reserved > stats.spirit) {
      gaps.push({
        stat: "Spirit",
        current: reserved,
        target: stats.spirit,
        severity: "critical",
        note: `Spirit over-reserved (${reserved}/${stats.spirit}). Drop a reservation or raise the pool.`,
      });
    } else if (pct >= 0.92) {
      gaps.push({
        stat: "Spirit",
        current: reserved,
        target: stats.spirit,
        severity: "warn",
        note: `Spirit ${reserved}/${stats.spirit} (${Math.round(pct * 100)}%) reserved — little room for more auras/utility.`,
      });
    }
  }

  // 4. Is there any real mitigation layer, or is it life-only?
  const layers: string[] = [];
  if ((stats.armour ?? 0) >= 1000) layers.push("armour");
  if ((stats.evasion ?? 0) >= 1000) layers.push("evasion");
  if ((stats.blockChance ?? 0) >= 20) layers.push("block");
  if ((stats.energyShield ?? 0) >= 500) layers.push("energy shield");
  if ((stats.ward ?? 0) >= 300) layers.push("ward");
  if (layers.length === 0) {
    gaps.push({
      stat: "DefensiveLayers",
      severity: "warn",
      note: "No strong mitigation layer (armour/evasion/block/ES/ward all low) — relying on the life pool alone.",
    });
  }

  gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const crits = gaps.filter((g) => g.severity === "critical");
  const warns = gaps.filter((g) => g.severity === "warn");
  const who = ctx.ascendancy || ctx.className || "Build";
  const headline =
    crits.length > 0
      ? `${crits.length} critical issue${crits.length > 1 ? "s" : ""} to fix`
      : warns.length > 0
        ? `${warns.length} thing${warns.length > 1 ? "s" : ""} to tighten up`
        : "survivability looks solid";
  const summary =
    `${who}${level > 1 ? ` (L${level})` : ""}: ${headline}. ` +
    `eHP ~${ehp !== undefined ? Math.round(ehp) : "?"}, ` +
    `layers: ${layers.join(", ") || "life only"}.`;

  // Preliminary, gap-driven upgrade steps (critical first). The matched-build
  // path planner will later replace/augment these with concrete item targets.
  const path: UpgradeStep[] = [...crits, ...warns].map((g) => ({
    kind: g.stat.endsWith("Resist") ? "item" : g.stat === "Spirit" ? "config" : "item",
    description: gapToAction(g),
    statDelta:
      g.target !== undefined && g.current !== undefined
        ? { [g.stat]: g.target - g.current }
        : undefined,
  }));

  return { summary, gaps, path };
}

function gapToAction(g: StatGap): string {
  if (g.stat.endsWith("Resist") && g.target !== undefined && g.current !== undefined && g.current < g.target) {
    const elem = g.stat.replace("Resist", "");
    return `Raise ${elem} resistance to ${g.target}% (need +${g.target - g.current}%) via gear mods or runes.`;
  }
  if (g.stat === "TotalEHP") {
    return `Increase effective HP toward ~${g.target} — more life/ES, a mitigation layer, or higher max resistances.`;
  }
  if (g.stat === "Spirit") {
    return `Free up Spirit (drop or swap a reservation) or raise the pool (sceptre +100, body armour, amulet, passives).`;
  }
  if (g.stat === "DefensiveLayers") {
    return `Add a mitigation layer (armour / evasion / block / energy shield / ward) — don't rely on the life pool alone.`;
  }
  return g.note;
}

const ICON: Record<GapSeverity, string> = { critical: "✗", warn: "!", ok: "·" };

/** Render a SurvivalGuide as plain text for the CLI. */
export function renderSurvivalGuide(guide: SurvivalGuide): string {
  const lines: string[] = [guide.summary, "", "Survivability:"];
  for (const gap of guide.gaps) lines.push(`  ${ICON[gap.severity]} ${gap.note}`);
  if (guide.path.length > 0) {
    lines.push("", "Suggested next upgrades:");
    guide.path.forEach((step, i) => lines.push(`  ${i + 1}. ${step.description}`));
  }
  return lines.join("\n");
}
