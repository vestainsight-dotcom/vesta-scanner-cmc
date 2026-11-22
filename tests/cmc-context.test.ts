// vesta.cmc.context.v1 schema and the context builder. Synthetic data. [CMC Hackathon]

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext, toIso, unavailableContext, type ContextInput } from "@/lib/cmc/context";
import { globalResponseSchema, quotesResponseSchema, quoteItems, mapResponseSchema } from "@/lib/cmc/raw";
import { mapContracts } from "@/lib/cmc/symbol-map";
import { ATTRIBUTION, CMC_CONTEXT_SCHEMA, MAX_ASSETS, cmcContextSchema, tierOf } from "@/lib/schema/cmc-context-v1";
import { fearGreedData, globalBody, mapBody, quotesBody, type QuoteRow } from "./fixtures/cmc";

const GEN = Date.UTC(2030, 0, 1, 1, 0, 0);
const map = mapResponseSchema.parse(
  mapBody([
    { id: 900001, symbol: "AAA", rank: 3 },
    { id: 24478, symbol: "PEPE", rank: 120 },
    { id: 900011, symbol: "DUP" },
    { id: 900012, symbol: "DUP" },
  ]),
).data;
const quotes = (rows: QuoteRow[]) => quoteItems(quotesResponseSchema.parse(quotesBody(rows)).data);
const global = globalResponseSchema.parse(globalBody()).data;

function input(over: Partial<ContextInput> = {}): ContextInput & { asOfMs: number | null } {
  return {
    generatedMs: GEN,
    mappings: mapContracts(["AAAUSDT", "1000PEPEUSDT", "DUPUSDT", "NONEUSDT"], map),
    quotes: quotes([
      { id: 900001, symbol: "AAA", rank: 3, price: 10 },
      { id: 24478, symbol: "PEPE", rank: 120, price: 0.00001 },
    ]),
    global,
    fearGreed: fearGreedData(),
    failures: [],
    stale: false,
    asOfMs: GEN - 90_000,
    ...over,
  };
}

test("a complete context is ok, valid and attributed", () => {
  const c = buildContext(input());
  assert.equal(c.schema, CMC_CONTEXT_SCHEMA);
  assert.equal(c.status, "ok");
  assert.equal(c.reason, null);
  assert.equal(c.generated_at, "2030-01-01T01:00:00Z");
  assert.deepEqual(c.attribution, ATTRIBUTION);
  assert.deepEqual(
    c.assets.map((a) => [a.symbol, a.state]),
    [
      ["AAAUSDT", "OK"],
      ["1000PEPEUSDT", "OK"],
      ["DUPUSDT", "AMBIGUOUS"],
      ["NONEUSDT", "UNMAPPED"],
    ],
  );
  const pepe = c.assets[1];
  assert.ok(pepe.state === "OK");
  assert.equal(pepe.multiplier, 1000);
  assert.equal(pepe.price_usd, 0.00001); // per asset unit, not per contract
  assert.equal(pepe.tier, "MID");
  assert.equal(pepe.updated_at, "2030-01-01T00:59:30Z");
  assert.equal(c.backdrop?.btc_dominance_pct, 55.5);
  assert.equal(c.backdrop?.derivatives_volume_24h_usd, 900_000_000_000);
  assert.deepEqual(c.backdrop?.fear_greed, { value: 61, classification: "Greed", updated_at: "2030-01-01T00:45:00Z" });
  assert.equal(cmcContextSchema.safeParse(c).success, true);
});

test("the contract has no field combining scanner and CMC volume", () => {
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      walk(x);
    }
  };
  walk(buildContext(input()));
  for (const k of keys) assert.doesNotMatch(k, /ratio|futures|spot|signal|score/i, k);
  // and such a field is rejected by the strict schema
  const c = structuredClone(buildContext(input())) as Record<string, unknown> & { assets: Record<string, unknown>[] };
  c.assets[0].futures_spot_ratio = 1.2;
  assert.equal(cmcContextSchema.safeParse(c).success, false);
});

test("size tiers follow CMC rank boundaries", () => {
  assert.deepEqual(
    [1, 50, 51, 200, 201, 1000, 1001, null, 0].map((r) => tierOf(r)),
    ["TOP_50", "TOP_50", "MID", "MID", "SMALL", "SMALL", "MICRO", "UNRANKED", "UNRANKED"],
  );
});

test("a mapped asset without a quote makes the context partial", () => {
  const c = buildContext(input({ quotes: quotes([{ id: 900001, symbol: "AAA" }]) }));
  assert.equal(c.status, "partial");
  assert.equal(c.reason, "BAD_RESPONSE");
  assert.equal(c.assets[1].state, "NO_QUOTE");
});

test("failed parts give partial with the first reason; stale is carried", () => {
  const c = buildContext(input({ fearGreed: null, failures: ["PLAN_FORBIDDEN", "TIMEOUT"], stale: true }));
  assert.equal(c.status, "partial");
  assert.equal(c.reason, "PLAN_FORBIDDEN");
  assert.equal(c.stale, true);
  assert.equal(c.backdrop?.fear_greed, null);
  assert.ok(c.backdrop?.total_market_cap_usd);
});

test("backdrop only (quotes failed) is partial; nothing usable is unavailable", () => {
  const b = buildContext(input({ quotes: null, failures: ["RATE_LIMITED"] }));
  assert.equal(b.status, "partial");
  assert.ok(b.assets.every((a) => a.state !== "OK"));

  const u = buildContext(input({ mappings: null, quotes: null, global: null, fearGreed: null, failures: ["NO_KEY"] }));
  assert.deepEqual(u, unavailableContext("NO_KEY", GEN));
  assert.equal(u.status, "unavailable");
  assert.deepEqual([u.backdrop, u.assets], [null, []]);
});

test("schema refuses inconsistent contexts", () => {
  const ok = buildContext(input());
  // plants one invalid value at `path` in a copy and validates it
  const valid = (path: (string | number)[], value: unknown) => {
    const c: unknown = structuredClone(ok);
    let node = c as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
    node[path[path.length - 1]] = value;
    return cmcContextSchema.safeParse(c).success;
  };
  assert.equal(valid(["status"], "ok"), true);
  assert.equal(valid(["assets", 0, "tier"], "MICRO"), false); // tier must match rank
  assert.equal(valid(["assets", 3], structuredClone(ok.assets[0])), false); // duplicate symbol
  assert.equal(valid(["status"], "unavailable"), false); // unavailable must carry no data and a reason
  assert.equal(valid(["reason"], "TIMEOUT"), false); // ok has no reason
  assert.equal(valid(["attribution", "text"], "Data"), false);
  assert.equal(valid(["assets", 0, "multiplier"], 10), false);
  const tooMany = Array.from({ length: MAX_ASSETS + 1 }, (_, i) => ({ symbol: `S${i}USDT`, state: "UNMAPPED" }));
  assert.equal(valid(["assets"], tooMany), false);
});

test("out-of-range numbers and bad timestamps become null, not errors", () => {
  const c = buildContext(
    input({
      quotes: quotes([
        { id: 900001, symbol: "AAA", rank: 3, price: -1, market_cap: 1e16, volume_24h: -5, last_updated: "not a date" },
        { id: 24478, symbol: "PEPE", rank: 120 },
      ]),
    }),
  );
  const a = c.assets[0];
  assert.ok(a.state === "OK");
  assert.deepEqual([a.price_usd, a.market_cap_usd, a.volume_24h_usd], [null, null, null]);
  assert.equal(a.updated_at, "2030-01-01T00:59:30Z"); // falls back to the item's last_updated
  assert.equal(toIso("2030-01-01T00:00:00.123Z"), "2030-01-01T00:00:00Z");
  assert.equal(toIso("garbage"), null);
  assert.equal(toIso(null), null);
});

test("unexpected text from CMC drops the asset or the field instead of showing it", () => {
  // the quote's symbol differs from the mapped symbol
  const c = buildContext(input({ quotes: quotes([{ id: 900001, symbol: "ZZZ" }, { id: 24478, symbol: "PEPE" }]) }));
  assert.equal(c.assets[0].state, "UNMAPPED");
  const f = buildContext(input({ fearGreed: fearGreedData({ value_classification: "<b>Greed</b>" }) }));
  assert.equal(f.backdrop?.fear_greed, null);
  const r = buildContext(input({ fearGreed: fearGreedData({ value: 140 }) }));
  assert.equal(r.backdrop?.fear_greed, null);
});

// ---------- C6-L3: CMC coin page name (slug) ----------
test("slug: passed through only when map and quote agree for the verified id; never on non-OK assets", () => {
  const ok = buildContext(input());
  const bySym = new Map(ok.assets.map((a) => [a.symbol, a]));
  const aaa = bySym.get("AAAUSDT");
  const pepe = bySym.get("1000PEPEUSDT");
  assert.ok(aaa?.state === "OK" && aaa.slug === "synthetic-aaa");
  assert.ok(pepe?.state === "OK" && pepe.slug === "synthetic-pepe"); // base coin of the 1000x contract
  for (const s of ["DUPUSDT", "NONEUSDT"]) assert.ok(!("slug" in (bySym.get(s) ?? {})), `${s} has no slug`);

  // the quote disagrees with the map -> no slug (the asset itself stays OK)
  const disagree = quotes([
    { id: 900001, symbol: "AAA", rank: 3, price: 10 },
    { id: 24478, symbol: "PEPE", rank: 120, price: 0.00001 },
  ]).map((q) => (q.id === 900001 ? { ...q, slug: "another-coin" } : q));
  const c = buildContext(input({ quotes: disagree }));
  const a = c.assets.find((x) => x.symbol === "AAAUSDT");
  assert.ok(a?.state === "OK" && a.slug === undefined);
  assert.equal(cmcContextSchema.safeParse(c).success, true);
});

test("slug: the schema accepts CMC page names only", () => {
  const base = buildContext(input());
  const withSlug = (slug: unknown) => {
    const c = structuredClone(base);
    const a = c.assets.find((x) => x.state === "OK") as Record<string, unknown>;
    a.slug = slug;
    return cmcContextSchema.safeParse(c).success;
  };
  for (const good of ["bitcoin", "pepe", "terra-luna-2", "1inch"]) assert.equal(withSlug(good), true, good);
  for (const bad of ["", "Bitcoin", "bit/coin", "../x", "bitcoin?x=1", "-btc", "btc-", "a--b", "https://evil.test", "a".repeat(81), 7]) {
    assert.equal(withSlug(bad), false, String(bad));
  }
  // absent is fine (older or unverified data)
  assert.equal(withSlug(undefined), true);
});
