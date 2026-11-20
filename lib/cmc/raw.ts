// Validation of raw CoinMarketCap responses. [CMC Hackathon — new integration]
//
// Raw schemas only describe the fields this project reads; CMC may add fields at
// any time, so unknown keys are stripped (not rejected). Every value that is
// used is bounded. Shapes follow the CMC Pro API reference examples; C2 checks
// them against real responses before anything is shown.
//
// Two documented ambiguities are handled explicitly:
//   - /v3 quotes: `data` is an array in the example, but the reference also
//     says v3 responses are maps keyed by the requested identifiers. Both are
//     accepted and normalised to an array.
//   - /v3 quotes: `quote` is an array of { symbol, ... } in the example; an
//     object keyed by currency is also accepted.

import { z } from "zod";

const bounded = z.number().finite().gt(-1e18).lt(1e18);
const num = bounded.nullable().optional();
const id = z.number().int().min(1).max(1e9);
const text = (max: number) => z.string().max(max);
// CMC timestamps are ISO-8601 strings; checked further when converted.
const ts = z.string().max(40).nullable().optional();

export const statusSchema = z.object({
  timestamp: ts,
  // documented as a number; one example shows the string "0"
  error_code: z.union([z.number().int(), z.string().regex(/^\d{1,6}$/)]).nullable().optional(),
  error_message: text(500).nullable().optional(),
  elapsed: num,
  credit_count: z.number().int().min(0).max(1_000_000).nullable().optional(),
  notice: text(1000).nullable().optional(),
});
export type CmcStatus = z.infer<typeof statusSchema>;

// ---- /v1/cryptocurrency/map ----
export const mapItemSchema = z.object({
  id,
  rank: z.number().int().min(0).max(1e7).nullable().optional(),
  name: text(200),
  symbol: text(64),
  slug: text(200),
  is_active: z.union([z.literal(0), z.literal(1)]).optional(),
});
export type CmcMapItem = z.infer<typeof mapItemSchema>;
export const mapResponseSchema = z.object({ status: statusSchema, data: z.array(mapItemSchema).max(20_000) });

// ---- /v3/cryptocurrency/quotes/latest ----
const quoteValueSchema = z.object({
  price: num,
  volume_24h: num,
  cex_volume_24h: num,
  dex_volume_24h: num,
  volume_change_24h: num,
  percent_change_24h: num,
  percent_change_7d: num,
  market_cap: num,
  last_updated: ts,
});
const quoteArrayItem = quoteValueSchema.extend({ symbol: text(16) });
export type CmcQuoteValue = z.infer<typeof quoteValueSchema>;

export const quoteItemSchema = z.object({
  id,
  name: text(200),
  symbol: text(64),
  slug: text(200),
  cmc_rank: z.number().int().min(0).max(1e7).nullable().optional(),
  is_active: z.union([z.literal(0), z.literal(1), z.boolean()]).nullable().optional(),
  last_updated: ts,
  quote: z.union([z.array(quoteArrayItem).max(130), z.record(text(16), quoteValueSchema)]),
});
export type CmcQuoteItem = z.infer<typeof quoteItemSchema>;
export const quotesResponseSchema = z.object({
  status: statusSchema,
  data: z.union([z.array(quoteItemSchema).max(500), z.record(text(32), quoteItemSchema)]),
});

/** Normalises `data` to an array, whichever documented shape arrived. */
export function quoteItems(data: z.infer<typeof quotesResponseSchema>["data"]): CmcQuoteItem[] {
  return Array.isArray(data) ? data : Object.values(data);
}

/** The USD quote of one item, whichever documented shape arrived; null if absent. */
export function usdQuote(item: CmcQuoteItem): CmcQuoteValue | null {
  if (Array.isArray(item.quote)) return item.quote.find((q) => q.symbol === "USD") ?? null;
  return item.quote.USD ?? null;
}

// ---- /v1/global-metrics/quotes/latest ----
export const globalResponseSchema = z.object({
  status: statusSchema,
  data: z.object({
    btc_dominance: num,
    btc_dominance_24h_percentage_change: num,
    derivatives_volume_24h: num,
    last_updated: ts,
    quote: z.object({
      USD: z.object({ total_market_cap: num, total_volume_24h: num, last_updated: ts }),
    }),
  }),
});

// ---- /v3/fear-and-greed/latest ----
export const fearGreedResponseSchema = z.object({
  status: statusSchema,
  data: z.object({
    value: z.number().finite().min(0).max(100),
    value_classification: text(40),
    update_time: ts,
  }),
});

// ---- /v1/key/info (0 credits; usage self-check for manual smoke tests only) ----
const count = z.number().finite().min(0).max(1e12).nullable().optional();
export const keyInfoResponseSchema = z.object({
  status: statusSchema,
  data: z.object({
    plan: z
      .object({
        credit_limit_monthly: count,
        credit_limit_monthly_reset: text(100).nullable().optional(),
        credit_limit_monthly_reset_timestamp: ts,
        rate_limit_minute: count,
      })
      .optional(),
    usage: z
      .object({
        current_minute: z.object({ requests_made: count, requests_left: count }).optional(),
        current_day: z.object({ credits_used: count, credits_left: count }).optional(),
        current_month: z.object({ credits_used: count, credits_left: count }).optional(),
      })
      .optional(),
  }),
});
export type CmcKeyInfo = z.infer<typeof keyInfoResponseSchema>["data"];

/** Error body (status only), used to read error_code on non-2xx responses. */
export const errorResponseSchema = z.object({ status: statusSchema });
