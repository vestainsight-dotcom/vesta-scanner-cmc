// CMC context service with a fake CMC API and a fake clock. Synthetic data,
// no network. [CMC Hackathon, C3]

import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICIES } from "@/lib/cmc/cache";
import { CmcClient, CmcError } from "@/lib/cmc/client";
import { ENDPOINTS } from "@/lib/cmc/endpoints";
import { ApiKey, type KeyState } from "@/lib/cmc/env";
import { fearGreedResponseSchema, globalResponseSchema, mapResponseSchema, quoteItems, quotesResponseSchema } from "@/lib/cmc/raw";
import { DEMO_CONTRACTS, createCmcService, type CmcApi } from "@/lib/cmc/service";
import { DEFAULT_PINS, lookupSymbols, parseContract } from "@/lib/cmc/symbol-map";
import { MOCK_SYMBOLS } from "@/lib/mock/scenarios";
import { cmcContextSchema, type CmcContext } from "@/lib/schema/cmc-context-v1";
import { FAKE_KEY, fakeTransport, fearGreedBody, globalBody, mapBody, quotesBody, type MapRow } from "./fixtures/cmc";

const T0 = Date.UTC(2030, 0, 1, 1, 0, 0);
const KEY: KeyState = { kind: "present", key: ApiKey.parse(FAKE_KEY)! };

// ---- synthetic demo-universe map: every pinned ticker also has a copycat ----
const MAP_ROWS: MapRow[] = [];
const symbolOfId = new Map<number, string>();
DEMO_CONTRACTS.forEach((c, i) => {
  const p = parseContract(c);
  if (!("base" in p)) return;
  const pin = DEFAULT_PINS[c];
  if (pin !== undefined) {
    MAP_ROWS.push({ id: pin, symbol: p.base, rank: i + 1 }, { id: 990_000 + i, symbol: p.base, rank: 5_000 + i });
    symbolOfId.set(pin, p.base);
  } else {
    MAP_ROWS.push({ id: 910_000 + i, symbol: p.base, rank: i + 20 });
    symbolOfId.set(910_000 + i, p.base);
  }
});
const MAP = mapResponseSchema.parse(mapBody(MAP_ROWS)).data;
const quotesFor = (ids: readonly number[]) =>
  quoteItems(quotesResponseSchema.parse(quotesBody(ids.map((id) => ({ id, symbol: symbolOfId.get(id)!, rank: 10 })))).data);
const GLOBAL = globalResponseSchema.parse(globalBody()).data;
const FG = fearGreedResponseSchema.parse(fearGreedBody()).data;

type Behaviour = "ok" | CmcError;
function fakeApi() {
  const calls = { map: 0, quotes: 0, global: 0, fearGreed: 0 };
  const args: { map: string[][]; quotes: number[][] } = { map: [], quotes: [] };
  const behave: Record<keyof typeof calls, Behaviour> = { map: "ok", quotes: "ok", global: "ok", fearGreed: "ok" };
  const run = async <T>(name: keyof typeof calls, value: () => T) => {
    calls[name]++;
    const b = behave[name];
    if (b !== "ok") throw b;
    return { data: value(), credits: name === "map" ? 0 : 1 };
  };
  const api: CmcApi = {
    map: (s) => (args.map.push([...s]), run("map", () => MAP)),
    quotes: (ids) => (args.quotes.push([...ids]), run("quotes", () => quotesFor(ids))),
    global: () => run("global", () => GLOBAL),
    fearGreed: () => run("fearGreed", () => FG),
  };
  return { api, calls, args, behave };
}

function setup(key: KeyState = KEY, dailyCreditCap?: number) {
  let now = T0;
  const fake = fakeApi();
  let made = 0;
  const service = createCmcService({
    readKey: () => key,
    makeApi: () => (made++, fake.api),
    now: () => now,
    dailyCreditCap,
  });
  return { ...fake, service, tick: (ms: number) => (now += ms), made: () => made };
}
const err = (reason: ConstructorParameters<typeof CmcError>[0], endpoint: ConstructorParameters<typeof CmcError>[1], backoffMs = 0) =>
  new CmcError(reason, endpoint, { backoffMs });
const valid = (c: CmcContext) => assert.equal(cmcContextSchema.safeParse(c).success, true, JSON.stringify(c));

test("full demo universe: all 36 contracts map (13 via pins), ok, labelled", async () => {
  const s = setup();
  const c = await s.service.getContext();
  valid(c);
  assert.equal(c.status, "ok");
  assert.equal(c.scanner_rows, "SIMULATED");
  assert.equal(c.as_of, "2030-01-01T01:00:00Z");
  assert.equal(c.assets.length, MOCK_SYMBOLS.length);
  assert.ok(c.assets.every((a) => a.state === "OK"), JSON.stringify(c.assets.filter((a) => a.state !== "OK")));
  const btc = c.assets.find((a) => a.symbol === "BTCUSDT");
  assert.ok(btc?.state === "OK" && btc.cmc_id === 1); // the pin, not the copycat
  const pepe = c.assets.find((a) => a.symbol === "1000PEPEUSDT");
  assert.ok(pepe?.state === "OK" && pepe.cmc_id === 24478 && pepe.multiplier === 1000);
});

test("visitors cannot steer requests: fixed symbols, fixed ids, no input", async () => {
  const s = setup();
  assert.equal(s.service.getContext.length, 0);
  await s.service.getContext();
  assert.deepEqual(s.args.map, [lookupSymbols(MOCK_SYMBOLS)]);
  const expectedIds = [...symbolOfId.keys()].sort((a, b) => a - b);
  assert.deepEqual(s.args.quotes, [expectedIds]); // copycat ids are never requested
  assert.ok(Object.isFrozen(DEMO_CONTRACTS));
});

test("cached parts are reused until their TTL; concurrent requests share one fetch", async () => {
  const s = setup();
  await Promise.all(Array.from({ length: 20 }, () => s.service.getContext()));
  assert.deepEqual(s.calls, { map: 1, quotes: 1, global: 1, fearGreed: 1 });

  s.tick(POLICIES.quotes.ttlMs); // still fresh (<= ttl)
  await s.service.getContext();
  assert.deepEqual(s.calls, { map: 1, quotes: 1, global: 1, fearGreed: 1 });

  s.tick(1); // quotes (15 min) expired; global (30 min), fear & greed (60 min) and map (24 h) not
  const c = await s.service.getContext();
  assert.deepEqual(s.calls, { map: 1, quotes: 2, global: 1, fearGreed: 1 });
  assert.equal(c.as_of, "2030-01-01T01:00:00Z"); // oldest part: map / fear & greed from T0
});

test("as_of follows the market values, not the 24 h ID map cache", async () => {
  const s = setup();
  await s.service.getContext();
  s.tick(61 * 60_000); // quotes, global and fear & greed all expired and re-fetched; map still cached from T0
  const c = await s.service.getContext();
  assert.deepEqual(s.calls, { map: 1, quotes: 2, global: 2, fearGreed: 2 });
  assert.equal(c.as_of, "2030-01-01T02:01:00Z"); // not T0
  assert.equal(c.stale, false);

  // a stale ID map alone is reported (partial + reason) but does not mark market data stale
  s.tick(POLICIES.map.ttlMs);
  s.behave.map = err("UPSTREAM_ERROR", "map");
  const d = await s.service.getContext();
  assert.deepEqual([d.status, d.reason, d.stale], ["partial", "UPSTREAM_ERROR", false]);
  assert.ok(d.assets.every((a) => a.state === "OK"));
});

test("as_of is the real fetch time even when the fetch takes time (first, uncached request)", async () => {
  let now = T0;
  const fake = fakeApi();
  const slow: CmcApi = {
    map: async (s) => ((now += 700), fake.api.map(s)),
    quotes: async (ids) => ((now += 700), fake.api.quotes(ids)),
    global: async () => ((now += 900), fake.api.global()),
    fearGreed: async () => ((now += 900), fake.api.fearGreed()),
  };
  const service = createCmcService({ readKey: () => KEY, makeApi: () => slow, now: () => now });
  const c = await service.getContext();
  valid(c);
  // data arrived ~1-3 s after the request started: as_of reflects that, generated_at is not earlier
  assert.ok(Date.parse(c.as_of!) > T0, c.as_of!);
  assert.ok(c.generated_at >= c.as_of!);
});

test("missing, malformed and build-phase keys make no CMC request", async () => {
  for (const [key, reason] of [
    [{ kind: "missing" }, "NO_KEY"],
    [{ kind: "malformed" }, "NO_KEY"],
    [{ kind: "disabled" }, "DISABLED"],
  ] as const) {
    const s = setup(key);
    const c = await s.service.getContext();
    valid(c);
    assert.deepEqual([c.status, c.reason, c.as_of, c.assets.length, c.backdrop], ["unavailable", reason, null, 0, null]);
    assert.equal(s.made(), 0);
    assert.deepEqual(s.calls, { map: 0, quotes: 0, global: 0, fearGreed: 0 });
  }
});

test("401 everywhere (expired key) with no cache: unavailable UNAUTHORIZED", async () => {
  const s = setup();
  s.behave.map = err("UNAUTHORIZED", "map", 3_600_000);
  s.behave.global = err("UNAUTHORIZED", "global", 3_600_000);
  s.behave.fearGreed = err("UNAUTHORIZED", "fearGreed", 3_600_000);
  const c = await s.service.getContext();
  valid(c);
  assert.deepEqual([c.status, c.reason], ["unavailable", "UNAUTHORIZED"]);
  assert.equal(s.calls.quotes, 0); // no ids without a map
  // backoff: an hour of further visits costs nothing
  s.tick(30 * 60_000);
  await s.service.getContext();
  assert.deepEqual(s.calls, { map: 1, quotes: 0, global: 1, fearGreed: 1 });
});

test("403 on one endpoint degrades only that part", async () => {
  const s = setup();
  s.behave.fearGreed = err("PLAN_FORBIDDEN", "fearGreed", 3_600_000);
  const c = await s.service.getContext();
  valid(c);
  assert.deepEqual([c.status, c.reason], ["partial", "PLAN_FORBIDDEN"]);
  assert.equal(c.backdrop?.fear_greed, null);
  assert.ok(c.backdrop?.total_market_cap_usd);
  assert.ok(c.assets.every((a) => a.state === "OK"));
});

test("429 on quotes: assets have no quote, backdrop intact, backoff honoured", async () => {
  const s = setup();
  s.behave.quotes = err("RATE_LIMITED", "quotes", 10 * 60_000);
  const c = await s.service.getContext();
  valid(c);
  assert.deepEqual([c.status, c.reason], ["partial", "RATE_LIMITED"]);
  assert.ok(c.assets.every((a) => a.state === "NO_QUOTE"));
  assert.ok(c.backdrop);
  s.tick(5 * 60_000);
  await s.service.getContext();
  assert.equal(s.calls.quotes, 1); // still backing off
  s.tick(5 * 60_000 + 1);
  s.behave.quotes = "ok";
  const later = await s.service.getContext();
  assert.equal(s.calls.quotes, 2);
  assert.equal(later.status, "ok");
});

test("timeouts and malformed responses become partial with their reason", async () => {
  for (const [part, reason] of [
    ["global", "TIMEOUT"],
    ["fearGreed", "BAD_RESPONSE"],
    ["quotes", "NETWORK"],
  ] as const) {
    const s = setup();
    s.behave[part] = err(reason, part);
    const c = await s.service.getContext();
    valid(c);
    assert.deepEqual([c.status, c.reason], ["partial", reason], part);
  }
});

test("stale data: last good values with stale=true, reason and their original fetch time", async () => {
  const s = setup();
  await s.service.getContext();
  s.tick(POLICIES.quotes.ttlMs + 1);
  s.behave.quotes = err("RATE_LIMITED", "quotes", 60_000);
  s.behave.global = err("UPSTREAM_ERROR", "global");
  const c = await s.service.getContext();
  valid(c);
  assert.equal(c.stale, true);
  assert.deepEqual([c.status, c.reason], ["partial", "RATE_LIMITED"]); // quotes reported before global
  assert.ok(c.assets.every((a) => a.state === "OK")); // stale quotes still shown
  assert.ok(c.backdrop?.total_market_cap_usd); // stale global still shown
  assert.equal(c.as_of, "2030-01-01T01:00:00Z"); // labelled with when the data was fetched
  assert.notEqual(c.generated_at, c.as_of);
});

test("data older than the stale window is dropped, never shown", async () => {
  const s = setup();
  await s.service.getContext();
  s.tick(POLICIES.global.maxStaleMs + 1); // quotes + global too old to show; map still within its window; fear & greed re-fetched
  s.behave.quotes = err("UPSTREAM_ERROR", "quotes");
  s.behave.global = err("UPSTREAM_ERROR", "global");
  const c = await s.service.getContext();
  valid(c);
  assert.ok(c.assets.every((a) => a.state === "NO_QUOTE"));
  assert.equal(c.backdrop?.total_market_cap_usd, null);
  assert.ok(c.backdrop?.fear_greed); // its own refresh succeeded
});

test("never exposes the key or raw CMC fields", async () => {
  const s = setup();
  const json = JSON.stringify(await s.service.getContext());
  assert.ok(!json.includes(FAKE_KEY));
  for (const raw of ["credit_count", "error_code", "tags", "cex_volume_24h", "slug", "platform", "num_market_pairs", "quote"]) {
    assert.ok(!json.includes(`"${raw}"`), raw);
  }
});

test("end to end through the real validated client and a fake transport", async () => {
  const t = fakeTransport((req) => {
    const path = new URL(req.url).pathname;
    if (path === ENDPOINTS.map) return { body: mapBody(MAP_ROWS) };
    if (path === ENDPOINTS.quotes) {
      const ids = new URL(req.url).searchParams.get("id")!.split(",").map(Number);
      return { body: quotesBody(ids.map((id) => ({ id, symbol: symbolOfId.get(id)!, rank: 10 }))) };
    }
    if (path === ENDPOINTS.global) return { raw: "{ not json" }; // malformed
    if (path === ENDPOINTS.fearGreed) return { status: 429, headers: { "Retry-After": "120" }, body: { status: { error_code: 1008 } } };
    return { status: 404 };
  });
  const service = createCmcService({
    readKey: () => KEY,
    makeApi: (apiKey) => new CmcClient({ apiKey, transport: t.transport }),
    now: () => T0,
  });
  const c = await service.getContext();
  valid(c);
  assert.deepEqual([c.status, c.reason], ["partial", "BAD_RESPONSE"]); // global is reported before fear & greed
  assert.ok(c.assets.every((a) => a.state === "OK"));
  assert.equal(c.backdrop, null); // both backdrop sources failed -> no backdrop at all
  assert.equal(t.calls.length, 4); // one request per endpoint, no retries
  assert.ok(t.calls.every((r) => !r.url.includes(FAKE_KEY)));
});

test("daily credit cap: past the cap no request is sent; stale data is served, then it recovers next UTC day", async () => {
  // cap 4: first context costs 3 (quotes 1, global 1, fear & greed 1; map 0)
  const s = setup(KEY, 4);
  const first = await s.service.getContext();
  assert.equal(first.status, "ok");
  assert.deepEqual(s.calls, { map: 1, quotes: 1, global: 1, fearGreed: 1 });

  s.tick(POLICIES.quotes.ttlMs + 1); // quotes expire: 1 credit left -> allowed
  await s.service.getContext();
  assert.deepEqual(s.calls, { map: 1, quotes: 2, global: 1, fearGreed: 1 });

  s.tick(POLICIES.quotes.ttlMs + 1); // quotes + global expire, cap reached -> nothing sent
  const capped = await s.service.getContext();
  assert.deepEqual(s.calls, { map: 1, quotes: 2, global: 1, fearGreed: 1 });
  assert.deepEqual([capped.status, capped.reason, capped.stale], ["partial", "RATE_LIMITED", true]);
  assert.ok(capped.assets.every((a) => a.state === "OK")); // last good values still shown

  // many more visits on the same day never send a request
  for (let i = 0; i < 50; i++) {
    s.tick(60_000);
    await s.service.getContext();
  }
  assert.deepEqual(s.calls, { map: 1, quotes: 2, global: 1, fearGreed: 1 });

  // next UTC day: the counter resets, data refreshes
  s.tick(24 * 3600_000);
  const next = await s.service.getContext();
  assert.equal(next.status, "ok");
  assert.ok(s.calls.quotes === 3 && s.calls.global === 2);
});

test("daily credit cap: with cap 0 nothing that costs credits is ever requested", async () => {
  const s = setup(KEY, 0);
  const c = await s.service.getContext();
  assert.deepEqual([s.calls.quotes, s.calls.global, s.calls.fearGreed], [0, 0, 0]);
  assert.deepEqual([c.status, c.reason], ["unavailable", "RATE_LIMITED"]);
});
