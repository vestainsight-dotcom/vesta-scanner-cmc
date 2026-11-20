// CMC context service: fixed demo universe -> validated vesta.cmc.context.v1.
// [CMC Hackathon — new integration, C3]
//
// Visitors cannot steer CMC requests: getContext() takes no input. The symbol
// list (the demo universe), the derived CMC ids and the four endpoints are
// fixed, and every CMC part goes through its own TTL cache (single flight,
// backoff after failures, bounded stale window). Credit use is therefore
// bounded by the cache policies, not by traffic, and additionally capped per
// process and UTC day by CreditBudget (budget.ts): a request that would exceed
// the cap is never sent; the part degrades like a rate-limited one.
//
//   no key / malformed key  -> unavailable (NO_KEY); no request
//   build phase             -> unavailable (DISABLED); no request
//   part fails, has cache   -> stale value, stale=true, status partial + reason
//   part fails, no cache    -> that part missing, status partial + reason
//   nothing usable          -> unavailable + first reason
//
// Output is always validated against the schema; raw CMC responses and the
// key never leave this module.

import { CacheUnavailableError, POLICIES, TtlCache, type CacheResult } from "@/lib/cmc/cache";
import { CmcClient, CmcError, type CmcResult } from "@/lib/cmc/client";
import { buildContext, unavailableContext, type FearGreedData, type GlobalData } from "@/lib/cmc/context";
import { CreditBudget, DAILY_CREDIT_CAP } from "@/lib/cmc/budget";
import { expectedCredits, type EndpointName } from "@/lib/cmc/endpoints";
import { readCmcKey, type ApiKey, type KeyState } from "@/lib/cmc/env";
import { createHttpsTransport } from "@/lib/cmc/https-transport";
import type { CmcMapItem, CmcQuoteItem } from "@/lib/cmc/raw";
import { lookupSymbols, mapContracts } from "@/lib/cmc/symbol-map";
import { MOCK_SYMBOLS } from "@/lib/mock/scenarios";
import type { CmcContext, Reason } from "@/lib/schema/cmc-context-v1";

/** The fixed universe: the demo scanner's contracts. Never taken from a request. */
export const DEMO_CONTRACTS: readonly string[] = Object.freeze([...MOCK_SYMBOLS]);
export const ROUTE_TIMEOUT_MS = 6_000;

/** The subset of CmcClient the service needs (a fake in tests). */
export interface CmcApi {
  map(symbols: readonly string[]): Promise<CmcResult<CmcMapItem[]>>;
  quotes(ids: readonly number[]): Promise<CmcResult<CmcQuoteItem[]>>;
  global(): Promise<CmcResult<GlobalData>>;
  fearGreed(): Promise<CmcResult<FearGreedData>>;
}

export interface ServiceDeps {
  readKey: () => KeyState;
  makeApi: (key: ApiKey) => CmcApi;
  now: () => number;
  /** credits per UTC day for this process; default DAILY_CREDIT_CAP */
  dailyCreditCap?: number;
}

const reasonOf = (e: unknown): Reason => {
  const cause = e instanceof CacheUnavailableError ? e.cause : e;
  return cause instanceof CmcError ? cause.reason : "BAD_RESPONSE";
};

export function createCmcService(deps: ServiceDeps) {
  const opts = { now: deps.now };
  const caches = {
    map: new TtlCache<CmcMapItem[]>(POLICIES.map, opts),
    quotes: new TtlCache<CmcQuoteItem[]>(POLICIES.quotes, opts),
    global: new TtlCache<GlobalData>(POLICIES.global, opts),
    fearGreed: new TtlCache<FearGreedData>(POLICIES.fearGreed, opts),
  };
  const mapSymbols = lookupSymbols(DEMO_CONTRACTS);
  const budget = new CreditBudget(deps.dailyCreditCap ?? DAILY_CREDIT_CAP, deps.now);
  /** Reserve credits before a request; refuse (no request sent) past the daily cap. */
  const spend = (endpoint: EndpointName, credits: number) => {
    if (!budget.tryReserve(credits)) throw new CmcError("RATE_LIMITED", endpoint, { backoffMs: budget.msUntilReset() });
  };

  async function getContext(): Promise<CmcContext> {
    const generatedMs = deps.now();
    const key = deps.readKey();
    if (key.kind === "disabled") return unavailableContext("DISABLED", generatedMs);
    if (key.kind !== "present") return unavailableContext("NO_KEY", generatedMs);
    const api = deps.makeApi(key.key);

    // per part: value or null, plus its failure reason and fetch time
    type Part<T> = { value: T | null; failure: Reason | null; stale: boolean; fetchedAt: number | null };
    async function part<T>(cache: TtlCache<T>, cacheKey: string, load: () => Promise<T>): Promise<Part<T>> {
      try {
        const r: CacheResult<T> = await cache.get(cacheKey, load);
        return { value: r.value, failure: r.stale ? reasonOf(r.error) : null, stale: r.stale, fetchedAt: r.fetchedAt };
      } catch (e) {
        return { value: null, failure: reasonOf(e), stale: false, fetchedAt: null };
      }
    }

    const assets = (async () => {
      const map = await part(caches.map, "map", async () => (await api.map(mapSymbols)).data);
      if (!map.value) return { map, mappings: null, quotes: null };
      const mappings = mapContracts(DEMO_CONTRACTS, map.value);
      const ids = [...new Set(mappings.flatMap((m) => (m.status === "MAPPED" ? [m.cmc_id] : [])))].sort((a, b) => a - b);
      if (ids.length === 0) return { map, mappings, quotes: null };
      const quotes = await part(caches.quotes, `quotes:${ids.join(",")}`, async () => {
        spend("quotes", expectedCredits("quotes", ids.length));
        return (await api.quotes(ids)).data;
      });
      return { map, mappings, quotes };
    })();
    const [a, global, fearGreed] = await Promise.all([
      assets,
      part(caches.global, "global", async () => {
        spend("global", expectedCredits("global"));
        return (await api.global()).data;
      }),
      part(caches.fearGreed, "fearGreed", async () => {
        spend("fearGreed", expectedCredits("fearGreed"));
        return (await api.fearGreed()).data;
      }),
    ]);

    // fixed order, so the reported reason is deterministic
    const parts: Part<unknown>[] = a.quotes ? [a.map, a.quotes, global, fearGreed] : [a.map, global, fearGreed];
    const failures = parts.flatMap((p) => (p.failure ? [p.failure] : []));
    // as_of and stale describe the MARKET values shown (quotes, global, fear & greed).
    // The ID map (cached up to 24 h) holds no market values, so it must not make
    // fresh quotes look a day old; a map failure still shows up via status/reason.
    const market: Part<unknown>[] = a.quotes ? [a.quotes, global, fearGreed] : [global, fearGreed];
    const times = market.flatMap((p) => (p.value !== null && p.fetchedAt !== null ? [p.fetchedAt] : []));

    return buildContext({
      // stamped after the data is in, so a fresh fetch is never clamped to an earlier time
      generatedMs: deps.now(),
      mappings: a.mappings,
      quotes: a.quotes?.value ?? null,
      global: global.value,
      fearGreed: fearGreed.value,
      failures,
      stale: market.some((p) => p.stale),
      asOfMs: times.length ? Math.min(...times) : null,
    });
  }

  return { getContext };
}

// ---- default instance (one per server process; caches live with it) ----
let defaultService: ReturnType<typeof createCmcService> | undefined;

export function getCmcContext(): Promise<CmcContext> {
  defaultService ??= createCmcService({
    readKey: () => readCmcKey(),
    makeApi: (apiKey) => new CmcClient({ apiKey, transport: createHttpsTransport(), timeoutMs: ROUTE_TIMEOUT_MS }),
    now: Date.now,
  });
  return defaultService.getContext();
}
