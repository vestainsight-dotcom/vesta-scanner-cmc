// Raw CMC data -> vesta.cmc.context.v1. Pure functions, no I/O.
// [CMC Hackathon — new integration]
//
// Values are passed through as CMC reports them (USD) with three exceptions:
// timestamps are normalised to seconds-precision UTC, out-of-range numbers
// become null, and any text that does not fit the contract drops that asset to
// UNMAPPED rather than being shown. No derived market metric is computed here;
// in particular nothing combines scanner (futures) volume with CMC volume.
//
// Status:
//   ok          every requested part arrived (AMBIGUOUS / UNMAPPED rows are
//               expected outcomes, not failures)
//   partial     some part failed; `reason` is the first failure
//   unavailable nothing usable; no data, only a reason

import { usdQuote, type CmcQuoteItem } from "@/lib/cmc/raw";
import type { Mapping } from "@/lib/cmc/symbol-map";
import {
  ATTRIBUTION,
  CMC_CONTEXT_SCHEMA,
  MAX_ASSETS,
  cmcContextSchema,
  tierOf,
  type CmcAsset,
  type CmcBackdrop,
  type CmcContext,
  type Reason,
} from "@/lib/schema/cmc-context-v1";

export interface GlobalData {
  btc_dominance?: number | null;
  btc_dominance_24h_percentage_change?: number | null;
  derivatives_volume_24h?: number | null;
  last_updated?: string | null;
  quote: { USD: { total_market_cap?: number | null; total_volume_24h?: number | null; last_updated?: string | null } };
}
export interface FearGreedData {
  value: number;
  value_classification: string;
  update_time?: string | null;
}

export interface ContextInput {
  generatedMs: number;
  /** one mapping per scanner contract, in display order (at most MAX_ASSETS are used); null if the ID map could not be loaded */
  mappings: readonly Mapping[] | null;
  /** null if quotes could not be loaded */
  quotes: readonly CmcQuoteItem[] | null;
  global: GlobalData | null;
  fearGreed: FearGreedData | null;
  /** reasons of the parts that failed, in the order they failed */
  failures: readonly Reason[];
  /** true when any part was served from cache after a failed refresh */
  stale: boolean;
  /** fetch time of the oldest CMC part included (ms); null if none */
  asOfMs: number | null;
}

const LIMIT = 1e15;
const isoS = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
export function toIso(v: string | null | undefined): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? isoS(ms) : null;
}
const num = (v: number | null | undefined, min = -LIMIT): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > min && v < LIMIT ? v : null;
const nonNeg = (v: number | null | undefined) => {
  const n = num(v, -1);
  return n !== null && n >= 0 ? n : null;
};
const CMC_SYMBOL_RE = /^[\p{L}\p{N}$._-]{1,32}$/u;
const FG_CLASS_RE = /^[A-Za-z ]{1,24}$/;

function asset(m: Mapping, quotes: ReadonlyMap<number, CmcQuoteItem> | null): CmcAsset {
  const symbol = m.contract;
  if (m.status === "AMBIGUOUS") return { symbol, state: "AMBIGUOUS" };
  if (m.status === "UNMAPPED") return { symbol, state: "UNMAPPED" };
  const item = quotes?.get(m.cmc_id);
  const q = item ? usdQuote(item) : null;
  if (!item || !q) return { symbol, state: "NO_QUOTE" };
  const name = item.name.trim().slice(0, 80);
  if (!CMC_SYMBOL_RE.test(item.symbol) || name === "" || item.symbol !== m.cmc_symbol) {
    return { symbol, state: "UNMAPPED" };
  }
  if (m.multiplier !== 1 && m.multiplier !== 1_000 && m.multiplier !== 1_000_000) return { symbol, state: "UNMAPPED" };
  const rankRaw = item.cmc_rank;
  const rank = typeof rankRaw === "number" && Number.isInteger(rankRaw) && rankRaw >= 1 && rankRaw <= 1e7 ? rankRaw : null;
  const price = num(q.price, 0);
  return {
    symbol,
    state: "OK",
    cmc_id: m.cmc_id,
    cmc_symbol: item.symbol,
    name,
    multiplier: m.multiplier,
    rank,
    tier: tierOf(rank),
    price_usd: price !== null && price > 0 ? price : null,
    market_cap_usd: nonNeg(q.market_cap),
    volume_24h_usd: nonNeg(q.volume_24h),
    change_24h_pct: num(q.percent_change_24h),
    change_7d_pct: num(q.percent_change_7d),
    updated_at: toIso(q.last_updated) ?? toIso(item.last_updated),
  };
}

function backdrop(g: GlobalData | null, fg: FearGreedData | null): CmcBackdrop | null {
  if (!g && !fg) return null;
  const dom = num(g?.btc_dominance, -1);
  const fgOk = fg && Number.isFinite(fg.value) && fg.value >= 0 && fg.value <= 100 && FG_CLASS_RE.test(fg.value_classification);
  return {
    total_market_cap_usd: nonNeg(g?.quote.USD.total_market_cap),
    total_volume_24h_usd: nonNeg(g?.quote.USD.total_volume_24h),
    btc_dominance_pct: dom !== null && dom >= 0 && dom <= 100 ? dom : null,
    btc_dominance_change_24h_pct: num(g?.btc_dominance_24h_percentage_change),
    derivatives_volume_24h_usd: nonNeg(g?.derivatives_volume_24h),
    updated_at: toIso(g?.last_updated) ?? toIso(g?.quote.USD.last_updated),
    fear_greed: fgOk
      ? { value: Math.round(fg.value), classification: fg.value_classification, updated_at: toIso(fg.update_time) }
      : null,
  };
}

const envelope = (generatedMs: number) => ({
  schema: CMC_CONTEXT_SCHEMA,
  generated_at: isoS(generatedMs),
  scanner_rows: "SIMULATED" as const,
  attribution: { ...ATTRIBUTION },
});

/** Context that carries no data, only why. Always valid. */
export function unavailableContext(reason: Reason, generatedMs: number): CmcContext {
  return cmcContextSchema.parse({
    ...envelope(generatedMs),
    status: "unavailable",
    reason,
    as_of: null,
    stale: false,
    backdrop: null,
    assets: [],
  });
}

/** Builds and validates a context. Falls back to "unavailable" if nothing usable remains. */
export function buildContext(input: ContextInput): CmcContext {
  const quoteById = input.quotes ? new Map(input.quotes.map((q) => [q.id, q])) : null;
  const assets = input.mappings
    ? input.mappings.slice(0, MAX_ASSETS).map((m) => asset(m, quoteById))
    : [];
  const bd = backdrop(input.global, input.fearGreed);
  const anyAsset = assets.some((a) => a.state === "OK");
  const firstFailure = input.failures[0] ?? null;

  if (!anyAsset && !bd) return unavailableContext(firstFailure ?? "BAD_RESPONSE", input.generatedMs);

  const failed = input.failures.length > 0 || assets.some((a) => a.state === "NO_QUOTE");
  const result = cmcContextSchema.safeParse({
    ...envelope(input.generatedMs),
    status: failed ? "partial" : "ok",
    reason: failed ? (firstFailure ?? "BAD_RESPONSE") : null,
    // never later than generation time, whatever clock skew a caller has
    as_of: isoS(Math.min(input.asOfMs ?? input.generatedMs, input.generatedMs)),
    stale: input.stale,
    backdrop: bd,
    assets,
  });
  return result.success ? result.data : unavailableContext("BAD_RESPONSE", input.generatedMs);
}
