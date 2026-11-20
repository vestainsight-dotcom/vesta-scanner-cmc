// C2 live smoke test of the CMC integration. [CMC Hackathon]
//
//   node --env-file=.env.local --import ./tests/register.mjs scripts/cmc-smoke.ts --live
//   node --env-file=.env.local --import ./tests/register.mjs scripts/cmc-smoke.ts --key-info
//
// Makes AT MOST four requests, one per endpoint, in this order, and stops at
// the first failure (no retries, no polling):
//   1. /v1/cryptocurrency/map              (demo universe symbols; 0 credits)
//   2. /v3/cryptocurrency/quotes/latest    (mapped ids + ambiguous candidates; 1 credit)
//   3. /v1/global-metrics/quotes/latest    (1 credit)
//   4. /v3/fear-and-greed/latest           (1 credit)
//
// Prints summaries only: HTTP status, response SHAPE (key names and value
// types, no values), credits, rate-limit related header names and values,
// and the symbol mapping result. Raw bodies stay in memory and are never
// written to disk. The key is never printed (ApiKey redacts itself and
// request headers are never logged). Node's --env-file loads .env.local, so
// no project code opens that file.

import { CmcClient, CmcError, type Transport } from "@/lib/cmc/client";
import { buildContext } from "@/lib/cmc/context";
import { ENDPOINTS, expectedCredits, type EndpointName } from "@/lib/cmc/endpoints";
import { readCmcKey } from "@/lib/cmc/env";
import { createHttpsTransport } from "@/lib/cmc/https-transport";
import { usdQuote, type CmcMapItem, type CmcQuoteItem } from "@/lib/cmc/raw";
import { lookupSymbols, mapContracts, parseContract } from "@/lib/cmc/symbol-map";
import { MOCK_SYMBOLS } from "@/lib/mock/scenarios";

// --key-info: ONE request to /v1/key/info (documented 0 credits) -> plan limits and
// credit usage, to confirm the balance before and after a manual test. Nothing else.
if (process.argv.includes("--key-info")) {
  const k = readCmcKey();
  if (k.kind !== "present") {
    console.log(JSON.stringify({ key: k.kind }));
    process.exit(1);
  }
  try {
    const c = new CmcClient({ apiKey: k.key, transport: createHttpsTransport() });
    const { data, credits } = await c.keyInfo();
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          this_call_credit_count: credits,
          plan: data.plan ?? null,
          usage: { current_minute: data.usage?.current_minute ?? null, current_day: data.usage?.current_day ?? null, current_month: data.usage?.current_month ?? null },
        },
        null,
        2,
      ),
    );
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify(e instanceof CmcError ? { reason: e.reason, http: e.httpStatus, cmc_error_code: e.cmcErrorCode } : { error: "unknown" }));
    process.exit(1);
  }
}

if (!process.argv.includes("--live")) {
  console.error("cmc-smoke: refusing to run without --live (makes up to 4 real CMC requests) or --key-info (1 request, 0 credits)");
  process.exit(2);
}

// ---------- shape capture (no values) ----------
type Shape = string | Shape[] | { [k: string]: Shape };
function shape(v: unknown, depth = 0): Shape {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth > 6 ? "array" : v.length === 0 ? [] : [shape(v[0], depth + 1)];
  if (typeof v === "object") {
    if (depth > 6) return "object";
    const keys = Object.keys(v as object);
    // object keyed by ids: show one entry only
    if (keys.length > 3 && keys.every((k) => /^\d+$/.test(k))) {
      return { "<id>": shape((v as Record<string, unknown>)[keys[0]], depth + 1) };
    }
    return Object.fromEntries(keys.map((k) => [k, shape((v as Record<string, unknown>)[k], depth + 1)]));
  }
  return typeof v;
}
const RATE_HEADER = /rate|limit|retry|credit|quota/i;
interface Capture {
  status: number;
  bytes: number;
  headerNames: string[];
  rateHeaders: Record<string, string>;
  shape: Shape | "unparsable";
}
const captures = new Map<EndpointName, Capture>();
const endpointOf = (url: string) =>
  (Object.entries(ENDPOINTS).find(([, p]) => new URL(url).pathname === p)?.[0] ?? "map") as EndpointName;

const base = createHttpsTransport();
const capturing: Transport = async (req) => {
  const res = await base(req);
  const raw = await res.text();
  let parsed: Shape | "unparsable" = "unparsable";
  try {
    parsed = shape(JSON.parse(raw));
  } catch {
    // keep "unparsable"
  }
  // all header NAMES; values only for rate-limit-like headers (never cookies or auth)
  const headerNames = res.headerNames?.() ?? [];
  const rateHeaders: Record<string, string> = {};
  for (const name of headerNames) {
    if (!RATE_HEADER.test(name) || /cookie|auth|key/i.test(name)) continue;
    const v = res.header(name);
    if (v !== null) rateHeaders[name] = v.slice(0, 64);
  }
  captures.set(endpointOf(req.url), { status: res.status, bytes: raw.length, headerNames, rateHeaders, shape: parsed });
  return { status: res.status, header: res.header, text: async () => raw };
};

const out = (title: string, v: unknown) => console.log(`\n== ${title} ==\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
function stop(e: unknown, endpoint: EndpointName): never {
  if (e instanceof CmcError) {
    out(`STOPPED at ${endpoint}`, { reason: e.reason, http: e.httpStatus, cmc_error_code: e.cmcErrorCode });
  } else {
    out(`STOPPED at ${endpoint}`, { error: e instanceof Error ? e.name : "unknown" });
  }
  const cap = captures.get(endpoint);
  if (cap) out(`${endpoint} response (shape only)`, cap);
  process.exit(1);
}

// ---------- run ----------
const keyState = readCmcKey();
out("key", { state: keyState.kind }); // never the value
if (keyState.kind !== "present") process.exit(1);
const client = new CmcClient({ apiKey: keyState.key, transport: capturing });

// 1. map
const symbols = lookupSymbols(MOCK_SYMBOLS);
let mapItems: CmcMapItem[];
let mapCredits: number | null;
try {
  ({ data: mapItems, credits: mapCredits } = await client.map(symbols));
} catch (e) {
  stop(e, "map");
}
out("1. map", { ...captures.get("map"), credits: mapCredits, expected_credits: expectedCredits("map"), items: mapItems.length });

const mappings = mapContracts(MOCK_SYMBOLS, mapItems);
const bySymbol = new Map<string, CmcMapItem[]>();
for (const it of mapItems) if (it.is_active !== 0) bySymbol.set(it.symbol, [...(bySymbol.get(it.symbol) ?? []), it]);
out(
  "mapping (demo universe)",
  mappings
    .map((m) => {
      if (m.status === "MAPPED") {
        const rank = mapItems.find((i) => i.id === m.cmc_id)?.rank ?? null;
        return `${m.contract.padEnd(14)} MAPPED     id=${m.cmc_id} ${m.cmc_symbol} "${m.name}" rank=${rank} x${m.multiplier}`;
      }
      if (m.status === "AMBIGUOUS") {
        const p = parseContract(m.contract);
        const c = "base" in p ? (bySymbol.get(p.base) ?? []) : [];
        const list = c
          .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
          .map((i) => `id=${i.id} "${i.name}" rank=${i.rank}`)
          .join(" | ");
        return `${m.contract.padEnd(14)} AMBIGUOUS  ${m.candidates} candidates: ${list}`;
      }
      return `${m.contract.padEnd(14)} UNMAPPED   ${m.reason}`;
    })
    .join("\n"),
);

// 2. quotes: mapped ids + every ambiguous candidate (to compare their ranks)
const ids = new Set<number>();
for (const m of mappings) {
  if (m.status === "MAPPED") ids.add(m.cmc_id);
  if (m.status === "AMBIGUOUS") {
    const p = parseContract(m.contract);
    if ("base" in p) for (const c of bySymbol.get(p.base) ?? []) ids.add(c.id);
  }
}
let quotes: CmcQuoteItem[];
let quoteCredits: number | null;
try {
  ({ data: quotes, credits: quoteCredits } = await client.quotes([...ids]));
} catch (e) {
  stop(e, "quotes");
}
const got = new Set(quotes.map((q) => q.id));
const sums = quotes.map((q) => {
  const u = usdQuote(q);
  if (!u || u.volume_24h == null || u.cex_volume_24h == null || u.dex_volume_24h == null) return "n/a";
  const diff = Math.abs(u.cex_volume_24h + u.dex_volume_24h - u.volume_24h);
  return diff <= Math.max(1, u.volume_24h * 1e-6) ? "equal" : "differs";
});
out("2. quotes", {
  ...captures.get("quotes"),
  credits: quoteCredits,
  expected_credits: expectedCredits("quotes", quotes.length),
  requested_ids: ids.size,
  returned: quotes.length,
  missing_ids: [...ids].filter((i) => !got.has(i)),
  with_usd_quote: quotes.filter((q) => usdQuote(q) !== null).length,
  with_cmc_rank: quotes.filter((q) => typeof q.cmc_rank === "number").length,
  volume_24h_vs_cex_plus_dex: {
    equal: sums.filter((s) => s === "equal").length,
    differs: sums.filter((s) => s === "differs").length,
    not_available: sums.filter((s) => s === "n/a").length,
  },
});

// 3. global metrics
let global: Awaited<ReturnType<CmcClient["global"]>>["data"];
let globalCredits: number | null;
try {
  ({ data: global, credits: globalCredits } = await client.global());
} catch (e) {
  stop(e, "global");
}
out("3. global", {
  ...captures.get("global"),
  credits: globalCredits,
  expected_credits: expectedCredits("global"),
  present: {
    total_market_cap: global.quote.USD.total_market_cap != null,
    total_volume_24h: global.quote.USD.total_volume_24h != null,
    btc_dominance: global.btc_dominance != null,
    btc_dominance_24h_percentage_change: global.btc_dominance_24h_percentage_change != null,
    derivatives_volume_24h: global.derivatives_volume_24h != null,
    derivatives_volume_24h_is_zero: global.derivatives_volume_24h === 0,
    last_updated: global.last_updated != null,
  },
});

// 4. fear & greed
let fg: Awaited<ReturnType<CmcClient["fearGreed"]>>["data"];
let fgCredits: number | null;
try {
  ({ data: fg, credits: fgCredits } = await client.fearGreed());
} catch (e) {
  stop(e, "fearGreed");
}
out("4. fear & greed", { ...captures.get("fearGreed"), credits: fgCredits, expected_credits: expectedCredits("fearGreed") });

// ---------- end-to-end contract check (no further requests) ----------
const generatedMs = Date.now();
const ctx = buildContext({ generatedMs, mappings, quotes, global, fearGreed: fg, failures: [], stale: false, asOfMs: generatedMs });
const states: Record<string, number> = {};
const tiers: Record<string, number> = {};
for (const a of ctx.assets) {
  states[a.state] = (states[a.state] ?? 0) + 1;
  if (a.state === "OK") tiers[a.tier] = (tiers[a.tier] ?? 0) + 1;
}
out("vesta.cmc.context.v1 from live data", {
  status: ctx.status,
  reason: ctx.reason,
  asset_states: states,
  tiers,
  backdrop_present: ctx.backdrop !== null,
  fear_greed_present: ctx.backdrop?.fear_greed != null,
});
out("credits", { reported_total: client.creditsUsed, requests: captures.size });
