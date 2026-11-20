// GET /api/cmc/context response handling. No network, no Next.js. [CMC Hackathon, C3]

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildContext, unavailableContext } from "@/lib/cmc/context";
import { RESPONSE_HEADERS, isSameOriginBrowserRequest, respond } from "@/lib/cmc/route-handler";
import { cmcContextSchema, type CmcContext } from "@/lib/schema/cmc-context-v1";

const T0 = Date.UTC(2030, 0, 1, 1, 0, 0);
const okCtx = (): CmcContext =>
  buildContext({
    generatedMs: T0,
    mappings: [],
    quotes: null,
    global: { btc_dominance: 50, quote: { USD: { total_market_cap: 1e12, total_volume_24h: 1e11 } } },
    fearGreed: null,
    failures: [],
    stale: false,
    asOfMs: T0 - 60_000,
  });

async function body(r: Response) {
  const json = await r.json();
  assert.equal(cmcContextSchema.safeParse(json).success, true, JSON.stringify(json));
  return json as CmcContext;
}

const SO = "same-origin";

test("ok context: 200, validated body, private no-store (no shared copy), nosniff, json", async () => {
  const r = await respond(async () => okCtx(), SO, () => T0);
  assert.equal(r.status, 200);
  for (const [k, v] of Object.entries(RESPONSE_HEADERS)) assert.equal(r.headers.get(k), v);
  assert.equal(r.headers.get("Cache-Control"), "private, no-store");
  const b = await body(r);
  assert.equal(b.status, "ok");
  assert.equal(b.as_of, "2030-01-01T00:59:00Z");
  assert.equal(b.scanner_rows, "SIMULATED");
  assert.deepEqual(b.attribution, { provider: "CoinMarketCap", text: "Data provided by CoinMarketCap.com", url: "https://coinmarketcap.com" });
});

test("unavailable context: 503 with a valid body so clients degrade", async () => {
  const r = await respond(async () => unavailableContext("NO_KEY", T0), SO, () => T0);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual([(await body(r)).status, (await respond(async () => unavailableContext("NO_KEY", T0), SO)).status], ["unavailable", 503]);
});

test("a thrown error or an invalid context never reaches the client", async () => {
  const thrown = await respond(async () => {
    throw new Error(`boom with secret-ish detail`);
  }, SO, () => T0);
  assert.equal(thrown.status, 503);
  const b = await body(thrown);
  assert.deepEqual([b.status, b.reason], ["unavailable", "BAD_RESPONSE"]);
  assert.ok(!JSON.stringify(b).includes("boom"));

  const invalid = { ...okCtx(), extra_raw_field: { credit_count: 1 } } as unknown as CmcContext;
  const r = await respond(async () => invalid, SO, () => T0);
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(await body(r)).includes("credit_count"));
});

test("gate: anything but a same-origin browser request gets 403, no CMC data, and never runs the service", async () => {
  // null = header absent (curl, scripts, server-side scrapers); the rest are what browsers send
  // for other sites, sibling subdomains and typed/bookmarked URLs
  for (const site of [null, "", "cross-site", "same-site", "none", "SAME-ORIGIN", "same-origin, cross-site"]) {
    let calls = 0;
    const r = await respond(async () => (calls++, okCtx()), site, () => T0);
    assert.equal(r.status, 403, String(site));
    assert.equal(calls, 0, `${site}: the CMC service must not run (no credits spent)`);
    assert.equal(r.headers.get("Cache-Control"), "private, no-store");
    const text = await r.text();
    assert.doesNotMatch(text, /market_cap|btc_dominance|CoinMarketCap|assets/, String(site));
  }
  assert.equal(isSameOriginBrowserRequest("same-origin"), true);
});

test("the route file: GET only, never pre-rendered, server runtime, reads only Sec-Fetch-Site", () => {
  const src = readFileSync(new URL("../app/api/cmc/context/route.ts", import.meta.url), "utf-8");
  assert.match(src, /export const dynamic = "force-dynamic";/);
  assert.match(src, /export const runtime = "nodejs";/);
  assert.match(src, /export function GET\(request: Request\): Promise<Response>/);
  assert.match(src, /respond\(getCmcContext, request\.headers\.get\("sec-fetch-site"\)\)/);
  // no other use of the request: no URL, body, cookies or other headers
  assert.equal((src.match(/request\./g) ?? []).length, 1);
  assert.doesNotMatch(src, /export (async )?function (POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(src, /use client|searchParams|req\.|cookies|nextUrl/);
});

test("partial context: 200, same private no-store policy", async () => {
  const partial = buildContext({
    generatedMs: T0,
    mappings: [],
    quotes: null,
    global: { btc_dominance: 50, quote: { USD: { total_market_cap: 1e12, total_volume_24h: 1e11 } } },
    fearGreed: null,
    failures: ["UPSTREAM_ERROR"],
    stale: false,
    asOfMs: T0 - 60_000,
  });
  assert.equal(partial.status, "partial");
  const r = await respond(async () => partial, SO, () => T0);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Cache-Control"), "private, no-store");
});
