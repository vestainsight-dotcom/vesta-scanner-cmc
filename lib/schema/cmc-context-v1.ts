// CMC context contract: vesta.cmc.context.v1. [CMC Hackathon — new integration]
//
// Market context from CoinMarketCap shown NEXT TO scanner rows. It is separate
// from vesta.scan.public.v2, which is unchanged: scanner data and CMC data stay
// in two contracts so either can be absent without affecting the other.
//
// Context only, not a signal. In particular this contract has NO field that
// combines exchange futures volume with CMC volume: the two measure different
// markets (one venue's perpetual futures vs CMC's aggregated, adjusted spot
// volume) and no ratio of them has been validated.
//
// Like public-v2, every object is strict and every value bounded.

import { z } from "zod";

export const CMC_CONTEXT_SCHEMA = "vesta.cmc.context.v1";
export const MAX_ASSETS = 60; // = public-v2 MAX_ROWS
export const ATTRIBUTION = {
  provider: "CoinMarketCap",
  text: "Data provided by CoinMarketCap.com",
  url: "https://coinmarketcap.com",
} as const;

// Size tiers by CMC rank. A classification for filtering, not a signal.
export const TIERS = ["TOP_50", "MID", "SMALL", "MICRO", "UNRANKED"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_LIMITS = { TOP_50: 50, MID: 200, SMALL: 1000 } as const;
export function tierOf(rank: number | null): Tier {
  if (rank === null || rank < 1) return "UNRANKED";
  if (rank <= TIER_LIMITS.TOP_50) return "TOP_50";
  if (rank <= TIER_LIMITS.MID) return "MID";
  if (rank <= TIER_LIMITS.SMALL) return "SMALL";
  return "MICRO";
}

export const ASSET_STATES = ["OK", "AMBIGUOUS", "UNMAPPED", "NO_QUOTE"] as const;
export const CONTEXT_STATES = ["ok", "partial", "unavailable"] as const;
// Why context is unavailable or partial. Codes only, never upstream text.
export const REASONS = [
  "NO_KEY",
  "UNAUTHORIZED",
  "PLAN_FORBIDDEN",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "NETWORK",
  "BAD_RESPONSE",
  "DISABLED",
] as const;
export type Reason = (typeof REASONS)[number];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SYMBOL_RE = /^[\p{Lu}\p{Lo}\p{Nd}]{1,24}USDT$/u; // same as public-v2
const iso = z.string().regex(ISO_RE);
const bounded = z.number().finite().gt(-1e15).lt(1e15);
const nonNeg = bounded.min(0);
const usd = nonNeg.nullable();
const pct = bounded.nullable();

const assetBase = { symbol: z.string().regex(SYMBOL_RE) };

export const assetSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...assetBase,
    state: z.literal("OK"),
    cmc_id: z.number().int().min(1).max(1e9),
    cmc_symbol: z.string().regex(/^[\p{L}\p{N}$._-]{1,32}$/u),
    name: z.string().min(1).max(80),
    // asset units per scanner contract unit (1000PEPEUSDT -> 1000)
    multiplier: z.union([z.literal(1), z.literal(1_000), z.literal(1_000_000)]),
    rank: z.number().int().min(1).max(1e7).nullable(),
    tier: z.enum(TIERS),
    price_usd: bounded.positive().nullable(), // CMC price of ONE asset unit (not per contract)
    market_cap_usd: usd,
    volume_24h_usd: usd, // CMC aggregated 24h volume as CMC reports it
    change_24h_pct: pct,
    change_7d_pct: pct,
    updated_at: iso.nullable(),
  }),
  z.strictObject({ ...assetBase, state: z.literal("AMBIGUOUS") }),
  z.strictObject({ ...assetBase, state: z.literal("UNMAPPED") }),
  z.strictObject({ ...assetBase, state: z.literal("NO_QUOTE") }),
]);
export type CmcAsset = z.infer<typeof assetSchema>;

export const backdropSchema = z.strictObject({
  total_market_cap_usd: usd,
  total_volume_24h_usd: usd,
  btc_dominance_pct: bounded.min(0).max(100).nullable(),
  btc_dominance_change_24h_pct: pct,
  // CMC's own global derivatives volume, from the same source as total volume
  derivatives_volume_24h_usd: usd,
  updated_at: iso.nullable(),
  fear_greed: z
    .strictObject({
      value: z.number().int().min(0).max(100),
      classification: z.string().regex(/^[A-Za-z ]{1,24}$/),
      updated_at: iso.nullable(),
    })
    .nullable(),
});
export type CmcBackdrop = z.infer<typeof backdropSchema>;

export const cmcContextSchema = z
  .strictObject({
    schema: z.literal(CMC_CONTEXT_SCHEMA),
    status: z.enum(CONTEXT_STATES),
    reason: z.enum(REASONS).nullable(),
    generated_at: iso,
    // when the CMC market values in this context were fetched from CMC: the oldest
    // of quotes / global metrics / fear & greed (server-side caching can serve
    // older data). The symbol->ID map is not market data and does not count.
    // null when there is no data.
    as_of: iso.nullable(),
    // true when a market value is served from cache after a failed refresh
    stale: z.boolean(),
    // the scanner rows this context sits next to are simulated demo data; only
    // the CMC context is live
    scanner_rows: z.literal("SIMULATED"),
    attribution: z.strictObject({
      provider: z.literal(ATTRIBUTION.provider),
      text: z.literal(ATTRIBUTION.text),
      url: z.literal(ATTRIBUTION.url),
    }),
    backdrop: backdropSchema.nullable(),
    assets: z.array(assetSchema).max(MAX_ASSETS),
  })
  .superRefine((ctx, issue) => {
    const seen = new Set<string>();
    ctx.assets.forEach((a, i) => {
      if (seen.has(a.symbol)) issue.addIssue({ code: "custom", path: ["assets", i, "symbol"], message: "duplicate symbol" });
      seen.add(a.symbol);
      if (a.state === "OK" && a.tier !== tierOf(a.rank)) {
        issue.addIssue({ code: "custom", path: ["assets", i, "tier"], message: "tier does not match rank" });
      }
    });
    if (ctx.status === "unavailable") {
      if (ctx.reason === null) issue.addIssue({ code: "custom", path: ["reason"], message: "unavailable needs a reason" });
      if (ctx.backdrop !== null || ctx.assets.length > 0 || ctx.as_of !== null) {
        issue.addIssue({ code: "custom", path: ["status"], message: "unavailable context carries no data" });
      }
    } else {
      if (ctx.as_of === null) issue.addIssue({ code: "custom", path: ["as_of"], message: "data needs its fetch time" });
      else if (ctx.as_of > ctx.generated_at) issue.addIssue({ code: "custom", path: ["as_of"], message: "as_of after generated_at" });
    }
    if (ctx.status === "ok" && ctx.reason !== null) {
      issue.addIssue({ code: "custom", path: ["reason"], message: "ok context has no reason" });
    }
  });
export type CmcContext = z.infer<typeof cmcContextSchema>;
