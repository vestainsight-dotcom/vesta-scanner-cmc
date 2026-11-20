// View model for the CMC context on the demo page. Pure functions, no React,
// no network. Only fields of vesta.cmc.context.v1 are used; nothing is
// derived from scanner data, and nothing is computed from CMC values beyond
// formatting. [CMC Hackathon — C4]

import type { CmcLoad } from "@/lib/data/cmc-context-client";
import type { CmcAsset, CmcContext } from "@/lib/schema/cmc-context-v1";

export type CmcBadge = "LOADING" | "LIVE" | "STALE" | "PARTIAL" | "UNAVAILABLE";

/** Source labels to show for the CMC section, most important last. */
export function cmcBadges(load: CmcLoad): CmcBadge[] {
  if (load.kind === "loading") return ["LOADING"];
  if (load.kind === "error" || load.ctx.status === "unavailable") return ["UNAVAILABLE"];
  const out: CmcBadge[] = ["LIVE"];
  if (load.ctx.stale) out.push("STALE");
  if (load.ctx.status === "partial") out.push("PARTIAL");
  return out;
}

/** The context, only when it carries data (ok or partial). */
export function usableContext(load: CmcLoad): CmcContext | null {
  return load.kind === "loaded" && load.ctx.status !== "unavailable" ? load.ctx : null;
}

/** Per-symbol CMC assets, or null when no row can be enriched (columns hidden). */
export function assetsBySymbol(load: CmcLoad): Map<string, CmcAsset> | null {
  const ctx = usableContext(load);
  if (!ctx || !ctx.assets.some((a) => a.state === "OK")) return null;
  return new Map(ctx.assets.map((a) => [a.symbol, a]));
}

/** $3.12T / $812.40B / $45.20M / $9.9K; null -> "—". */
export function formatUsdCompact(v: number | null): string {
  if (v === null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** 56.20% ; null -> "—". */
export const formatShare = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);

/** Percentage-point change, signed: +0.40 pp ; null -> "—". */
export function formatPp(v: number | null): string {
  if (v === null) return "—";
  const s = v.toFixed(2);
  return `${v > 0 ? "+" : ""}${s === "-0.00" ? "0.00" : s} pp`;
}

export const FEAR_GREED_CLASSES = ["EXTREME_FEAR", "FEAR", "NEUTRAL", "GREED", "EXTREME_GREED"] as const;
export type FearGreedClass = (typeof FEAR_GREED_CLASSES)[number];

/** CMC's classification text -> a known class (for translation), or null (show CMC's text as is). */
export function fearGreedClass(text: string): FearGreedClass | null {
  const k = text.trim().toUpperCase().replace(/\s+/g, "_");
  return (FEAR_GREED_CLASSES as readonly string[]).includes(k) ? (k as FearGreedClass) : null;
}
