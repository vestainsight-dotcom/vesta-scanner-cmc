// HTTPS transport with an injected fetch. No network. [CMC Hackathon, C2]

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { CmcClient, ResponseTooLargeError } from "@/lib/cmc/client";
import { CMC_BASE_URL, ENDPOINTS } from "@/lib/cmc/endpoints";
import { ApiKey } from "@/lib/cmc/env";
import { TransportRefusedError, createHttpsTransport, isAllowedCmcUrl } from "@/lib/cmc/https-transport";
import { FAKE_KEY, fearGreedBody, j } from "./fixtures/cmc";

const ok = `${CMC_BASE_URL}${ENDPOINTS.fearGreed}`;
const req = (url: string) => ({ url, headers: { Accept: "application/json" }, signal: new AbortController().signal });

function recordingFetch(make: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (input: URL, init: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return make();
  };
  return { fetchImpl, calls };
}

test("only https URLs on the CMC host are allowed", () => {
  assert.equal(isAllowedCmcUrl(ok), true);
  for (const bad of [
    ok.replace("https:", "http:"),
    ok.replace("pro-api.", "api."),
    ok.replace("https://", j("https://u", ":p", "@")),
    ok.replace(".com/", ".com:8443/"),
    j("https://", "example", ".invalid/v1/x"),
    "not a url",
  ]) {
    assert.equal(isAllowedCmcUrl(bad), false, bad);
  }
});

test("refused URLs never reach fetch", async () => {
  const f = recordingFetch(() => new Response("{}"));
  const t = createHttpsTransport({ fetchImpl: f.fetchImpl });
  await assert.rejects(t(req(j("https://", "example", ".invalid/x"))), TransportRefusedError);
  await assert.rejects(t(req(ok.replace("https:", "http:"))), TransportRefusedError);
  assert.equal(f.calls.length, 0);
});

test("GET with the client's headers and signal, redirects refused, no HTTP cache", async () => {
  const f = recordingFetch(() => new Response(JSON.stringify(fearGreedBody()), { headers: { "x-test": "1" } }));
  const r = await createHttpsTransport({ fetchImpl: f.fetchImpl })(req(ok));
  const [{ url, init }] = f.calls;
  assert.equal(url, ok);
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { Accept: "application/json" });
  assert.equal(r.status, 200);
  assert.equal(r.header("x-test"), "1");
  assert.ok(r.headerNames?.().includes("x-test"));
  assert.equal(JSON.parse(await r.text()).data.value, 61);
});

test("bodies over the cap are refused, by declared length or while streaming", async () => {
  const declared = recordingFetch(() => new Response("x".repeat(10), { headers: { "content-length": "999" } }));
  await assert.rejects(createHttpsTransport({ maxBytes: 100, fetchImpl: declared.fetchImpl })(req(ok)), ResponseTooLargeError);

  const streamed = recordingFetch(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode("y".repeat(40)));
            c.close();
          },
        }),
      ),
  );
  await assert.rejects(createHttpsTransport({ maxBytes: 100, fetchImpl: streamed.fetchImpl })(req(ok)), ResponseTooLargeError);
});

test("the client maps an oversized body to BAD_RESPONSE and makes exactly one attempt", async () => {
  const f = recordingFetch(() => new Response("x".repeat(10), { headers: { "content-length": "999" } }));
  const transport = createHttpsTransport({ maxBytes: 100, fetchImpl: f.fetchImpl });
  const c = new CmcClient({ apiKey: ApiKey.parse(FAKE_KEY)!, transport });
  await assert.rejects(c.fearGreed(), (e: { reason?: string }) => e.reason === "BAD_RESPONSE");
  assert.equal(f.calls.length, 1); // no retry
});

test("a network failure is one attempt, reported as NETWORK", async () => {
  let calls = 0;
  const transport = createHttpsTransport({
    fetchImpl: async () => {
      calls++;
      throw new TypeError("fetch failed");
    },
  });
  const c = new CmcClient({ apiKey: ApiKey.parse(FAKE_KEY)!, transport });
  await assert.rejects(c.global(), (e: { reason?: string }) => e.reason === "NETWORK");
  assert.equal(calls, 1);
});

test("the smoke script refuses to run without --live", () => {
  const script = new URL("../scripts/cmc-smoke.ts", import.meta.url).pathname;
  const register = new URL("./register.mjs", import.meta.url).pathname;
  // no --env-file: the key is never loaded, and the script must refuse before any request
  const r = spawnSync(process.execPath, ["--import", register, script], { encoding: "utf-8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to run without --live/);
});
