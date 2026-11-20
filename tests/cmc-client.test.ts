// CMC client against a fake transport. No network. [CMC Hackathon]

import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { CmcClient, CmcError, MAX_RESPONSE_BYTES } from "@/lib/cmc/client";
import { CMC_HOST, CMC_KEY_HEADER, ENDPOINTS, expectedCredits } from "@/lib/cmc/endpoints";
import { ApiKey } from "@/lib/cmc/env";
import { usdQuote } from "@/lib/cmc/raw";
import { FAKE_KEY, fakeTransport, fearGreedBody, globalBody, mapBody, quotesBody, status } from "./fixtures/cmc";

const key = ApiKey.parse(FAKE_KEY)!;
const client = (t: ReturnType<typeof fakeTransport>, timeoutMs?: number) =>
  new CmcClient({ apiKey: key, transport: t.transport, timeoutMs });

async function reason(p: Promise<unknown>): Promise<CmcError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof CmcError, String(e));
    return e;
  }
  assert.fail("expected a CmcError");
}

test("requests go to the CMC host and allowed path, key only in the header", async () => {
  const t = fakeTransport(() => ({ body: quotesBody([{ id: 900001, symbol: "AAA" }]) }));
  await client(t).quotes([900003, 900001, 900001]);
  const [req] = t.calls;
  const url = new URL(req.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, CMC_HOST);
  assert.equal(url.pathname, ENDPOINTS.quotes);
  assert.equal(url.searchParams.get("id"), "900001,900003"); // deduplicated, sorted
  assert.equal(url.searchParams.get("convert"), "USD");
  assert.equal(req.headers[CMC_KEY_HEADER], FAKE_KEY);
  assert.ok(!req.url.includes(FAKE_KEY));
});

test("map, global and fear & greed use their endpoints and parse", async () => {
  const t = fakeTransport((req) => {
    const p = new URL(req.url).pathname;
    if (p === ENDPOINTS.map) return { body: mapBody([{ id: 900001, symbol: "AAA", rank: 7 }]) };
    if (p === ENDPOINTS.global) return { body: globalBody() };
    if (p === ENDPOINTS.fearGreed) return { body: fearGreedBody() };
    return { status: 404, body: {} };
  });
  const c = client(t);
  const m = await c.map(["BBB", "AAA", "AAA"]);
  assert.equal(new URL(t.calls[0].url).searchParams.get("symbol"), "AAA,BBB");
  assert.equal(new URL(t.calls[0].url).searchParams.get("listing_status"), "active");
  assert.equal(m.data[0].id, 900001);
  assert.equal((await c.global()).data.btc_dominance, 55.5);
  assert.equal((await c.fearGreed()).data.value, 61);
  assert.equal(c.creditsUsed, 2); // map reports 0, global 1, fear & greed 1
});

test("both documented quote shapes normalise to the same items", async () => {
  const rows = [
    { id: 900001, symbol: "AAA", price: 2 },
    { id: 900002, symbol: "BBB", price: 3 },
  ];
  for (const shape of ["array", "object"] as const) {
    const t = fakeTransport(() => ({ body: quotesBody(rows, shape) }));
    const { data } = await client(t).quotes([900001, 900002]);
    assert.deepEqual(
      data.map((d) => [d.id, usdQuote(d)?.price]),
      [
        [900001, 2],
        [900002, 3],
      ],
      shape,
    );
  }
});

test("empty input makes no request", async () => {
  const t = fakeTransport(() => assert.fail("no request expected"));
  assert.deepEqual(await client(t).quotes([]), { data: [], credits: 0 });
  assert.deepEqual(await client(t).map([]), { data: [], credits: 0 });
  assert.equal(t.calls.length, 0);
});

test("invalid ids or symbols are refused before any request", async () => {
  const t = fakeTransport(() => assert.fail("no request expected"));
  assert.equal((await reason(client(t).quotes([1.5]))).reason, "BAD_RESPONSE");
  assert.equal((await reason(client(t).quotes(Array.from({ length: 101 }, (_, i) => i + 1)))).reason, "BAD_RESPONSE");
  assert.equal((await reason(client(t).map(["A,B"]))).reason, "BAD_RESPONSE");
  assert.equal((await reason(client(t).map(["aaa"]))).reason, "BAD_RESPONSE");
  assert.equal(t.calls.length, 0);
});

test("HTTP and CMC error codes map to reasons and backoff hints", async () => {
  const cases: [number, Record<string, unknown>, Record<string, string>, string, number][] = [
    [401, { error_code: 1001 }, {}, "UNAUTHORIZED", 3_600_000],
    [402, { error_code: 1003 }, {}, "PLAN_FORBIDDEN", 3_600_000],
    [403, { error_code: 1006 }, {}, "PLAN_FORBIDDEN", 3_600_000],
    [429, { error_code: 1008 }, { "Retry-After": "120" }, "RATE_LIMITED", 120_000],
    [429, { error_code: 1008 }, {}, "RATE_LIMITED", 60_000],
    [429, { error_code: 1009 }, {}, "RATE_LIMITED", 3_600_000],
    [429, { error_code: 1010 }, {}, "RATE_LIMITED", 6 * 3_600_000],
    [500, { error_code: 500 }, {}, "UPSTREAM_ERROR", 120_000],
    [503, {}, {}, "UPSTREAM_ERROR", 120_000],
  ];
  for (const [http, st, headers, want, backoff] of cases) {
    const t = fakeTransport(() => ({ status: http, headers, body: { status: status({ ...st, error_message: "upstream text" }) } }));
    const e = await reason(client(t).global());
    assert.equal(e.reason, want, `${http}`);
    assert.equal(e.httpStatus, http);
    assert.equal(e.backoffMs, backoff, `${http} ${JSON.stringify(st)}`);
    assert.ok(!e.message.includes("upstream text")); // upstream messages are never passed on
  }
});

test("HTTP 200 carrying a CMC error code is still an error; string \"0\" is success", async () => {
  const bad = fakeTransport(() => ({ body: { status: status({ error_code: 1002 }), data: {} } }));
  assert.equal((await reason(client(bad).fearGreed())).reason, "UNAUTHORIZED");
  const ok = fakeTransport(() => ({ body: { ...fearGreedBody(), status: status({ error_code: "0" }) } }));
  assert.equal((await client(ok).fearGreed()).data.value_classification, "Greed");
});

test("malformed, mismatched and oversized bodies are BAD_RESPONSE", async () => {
  for (const out of [{ raw: "not json" }, { body: { status: status(), data: { value: "x" } } }, { raw: "x".repeat(MAX_RESPONSE_BYTES + 1) }]) {
    const t = fakeTransport(() => out);
    assert.equal((await reason(client(t).fearGreed())).reason, "BAD_RESPONSE");
  }
});

test("transport failures are NETWORK; a hung request times out and is aborted", async () => {
  const down = fakeTransport(() => Promise.reject(new Error("socket closed")) as Promise<never>);
  assert.equal((await reason(client(down).global())).reason, "NETWORK");

  let signal: AbortSignal | undefined;
  const hung = fakeTransport((req) => {
    signal = req.signal;
    return new Promise<never>(() => {});
  });
  const e = await reason(client(hung, 20).global());
  assert.equal(e.reason, "TIMEOUT");
  assert.equal(signal?.aborted, true);
});

test("errors never contain the API key", async () => {
  const t = fakeTransport(() => ({ status: 401, body: { status: status({ error_code: 1001 }) } }));
  const e = await reason(client(t).global());
  for (const shown of [e.message, String(e), JSON.stringify(e), inspect(e), e.stack ?? ""]) {
    assert.ok(!shown.includes(FAKE_KEY));
  }
  assert.ok(!inspect(client(t)).includes(FAKE_KEY));
});

test("documented credit rules", () => {
  assert.equal(expectedCredits("map"), 0);
  assert.equal(expectedCredits("keyInfo"), 0);
  assert.equal(expectedCredits("quotes", 60), 1);
  assert.equal(expectedCredits("quotes", 250), 1);
  assert.equal(expectedCredits("quotes", 251), 2);
  assert.equal(expectedCredits("global"), 1);
  assert.equal(expectedCredits("fearGreed"), 1);
});

test("every endpoint URL stays on the CMC host", () => {
  for (const name of Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]) {
    const u = new URL(CmcClient.buildUrl(name, { a: "../../x", b: "//evil.invalid" }));
    assert.equal(u.host, CMC_HOST);
    assert.equal(u.pathname, ENDPOINTS[name]);
  }
});

test("keyInfo: one request to /v1/key/info, usage numbers parsed (synthetic body)", async () => {
  const body = {
    status: status({ credit_count: 0 }),
    data: {
      plan: { credit_limit_monthly: 123_456, credit_limit_monthly_reset: "In 9 days", credit_limit_monthly_reset_timestamp: "2030-02-01T00:00:00.000Z", rate_limit_minute: 99 },
      usage: { current_minute: { requests_made: 1, requests_left: 98 }, current_day: { credits_used: 7 }, current_month: { credits_used: 70, credits_left: 123_386 } },
    },
  };
  const t = fakeTransport(() => ({ body }));
  const r = await client(t).keyInfo();
  assert.equal(new URL(t.calls[0].url).pathname, ENDPOINTS.keyInfo);
  assert.equal(t.calls.length, 1);
  assert.equal(r.credits, 0);
  assert.equal(r.data.usage?.current_month?.credits_left, 123_386);
  assert.equal(r.data.plan?.credit_limit_monthly, 123_456);
});

test("the context route never calls keyInfo", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["../lib/cmc/service.ts", "../lib/cmc/route-handler.ts", "../app/api/cmc/context/route.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf-8"), /keyInfo/, f);
  }
});
