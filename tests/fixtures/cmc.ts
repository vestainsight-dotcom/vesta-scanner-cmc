// SYNTHETIC CoinMarketCap-shaped fixtures for unit tests. [CMC Hackathon]
//
// Not CoinMarketCap data: every id, name, rank and number is invented, and ids
// are in a fictional range (900000+). Only the response SHAPES follow the CMC
// Pro API reference, so the parsers can be tested without any network access.

import type { TransportRequest, TransportResponse } from "@/lib/cmc/client";

export const j = (...p: string[]) => p.join("");
/** A key-shaped but fake value, assembled at runtime. */
export const FAKE_KEY = j("test", "Key", "0123456789", "abcdef");

export const status = (over: Record<string, unknown> = {}) => ({
  timestamp: "2030-01-01T01:00:00.000Z",
  error_code: 0,
  error_message: null,
  elapsed: 5,
  credit_count: 1,
  notice: null,
  ...over,
});

export interface MapRow {
  id: number;
  symbol: string;
  name?: string;
  rank?: number | null;
  is_active?: 0 | 1;
}
export const mapItem = (r: MapRow) => ({
  id: r.id,
  rank: r.rank ?? null,
  name: r.name ?? `Synthetic ${r.symbol}`,
  symbol: r.symbol,
  slug: `synthetic-${r.symbol.toLowerCase()}`,
  is_active: r.is_active ?? 1,
  first_historical_data: "2029-01-01T00:00:00.000Z",
  last_historical_data: "2030-01-01T00:00:00.000Z",
  platform: null,
});
export const mapBody = (rows: MapRow[]) => ({ status: status({ credit_count: 0 }), data: rows.map(mapItem) });

export interface QuoteRow {
  id: number;
  symbol: string;
  rank?: number | null;
  price?: number | null;
  market_cap?: number | null;
  volume_24h?: number | null;
  change24?: number | null;
  change7d?: number | null;
  last_updated?: string;
}
const usd = (r: QuoteRow) => ({
  price: r.price ?? 1.5,
  volume_24h: r.volume_24h ?? 2_000_000,
  cex_volume_24h: 1_500_000,
  dex_volume_24h: 500_000,
  volume_change_24h: 3.2,
  percent_change_1h: 0.1,
  percent_change_24h: r.change24 ?? -1.25,
  percent_change_7d: r.change7d ?? 4.5,
  market_cap: r.market_cap ?? 50_000_000,
  market_cap_dominance: 0.01,
  last_updated: r.last_updated ?? "2030-01-01T00:59:30.000Z",
});
export const quoteItem = (r: QuoteRow, shape: "array" | "object" = "array") => ({
  id: r.id,
  name: `Synthetic ${r.symbol}`,
  symbol: r.symbol,
  slug: `synthetic-${r.symbol.toLowerCase()}`,
  cmc_rank: r.rank === undefined ? 100 : r.rank,
  is_active: 1,
  num_market_pairs: 10,
  last_updated: "2030-01-01T00:59:30.000Z",
  tags: [],
  platform: null,
  quote: shape === "array" ? [{ id: 2781, symbol: "USD", ...usd(r) }] : { USD: usd(r) },
});
export const quotesBody = (rows: QuoteRow[], shape: "array" | "object" = "array", credits = 1) => ({
  status: status({ credit_count: credits, total_count: rows.length }),
  data:
    shape === "array"
      ? rows.map((r) => quoteItem(r, "array"))
      : Object.fromEntries(rows.map((r) => [String(r.id), quoteItem(r, "object")])),
});

export const globalData = (over: Record<string, unknown> = {}) => ({
  btc_dominance: 55.5,
  eth_dominance: 12.1,
  btc_dominance_24h_percentage_change: -0.4,
  derivatives_volume_24h: 900_000_000_000,
  last_updated: "2030-01-01T00:55:00.000Z",
  quote: {
    USD: {
      total_market_cap: 3_000_000_000_000,
      total_volume_24h: 120_000_000_000,
      last_updated: "2030-01-01T00:55:00.000Z",
    },
  },
  ...over,
});
export const globalBody = () => ({ status: status(), data: globalData() });

export const fearGreedData = (over: Record<string, unknown> = {}) => ({
  value: 61,
  value_classification: "Greed",
  update_time: "2030-01-01T00:45:00.000Z",
  ...over,
});
export const fearGreedBody = () => ({ status: status(), data: fearGreedData() });

/** Test transport: records requests and answers from a handler. */
export function fakeTransport(
  handler: (req: TransportRequest) => { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> } | Promise<never>,
) {
  const calls: TransportRequest[] = [];
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    calls.push(req);
    const out = await handler(req);
    const raw = out.raw ?? JSON.stringify(out.body ?? {});
    const headers = Object.fromEntries(Object.entries(out.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: out.status ?? 200, header: (n) => headers[n.toLowerCase()] ?? null, text: async () => raw };
  };
  return { transport, calls };
}
