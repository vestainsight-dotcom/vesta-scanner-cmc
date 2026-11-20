// Cache abstraction with a fake clock. [CMC Hackathon]

import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheUnavailableError, MemoryStore, POLICIES, TtlCache, type CachePolicy } from "@/lib/cmc/cache";
import { CmcError } from "@/lib/cmc/client";

const policy: CachePolicy = { ttlMs: 1_000, maxStaleMs: 10_000, backoffMs: 500 };
function setup(p = policy) {
  let now = 1_000_000;
  const clock = { tick: (ms: number) => (now += ms) };
  const cache = new TtlCache<number>(p, { now: () => now });
  return { cache, clock };
}
const counter = () => {
  let n = 0;
  const load = async () => ++n;
  return { load, calls: () => n };
};
const fail = (e: unknown = new Error("down")) => async (): Promise<number> => {
  throw e;
};

test("fresh values are served without reloading; expired values reload", async () => {
  const { cache, clock } = setup();
  const c = counter();
  assert.deepEqual(await cache.get("k", c.load), { value: 1, fetchedAt: 1_000_000, stale: false });
  clock.tick(1_000);
  assert.equal((await cache.get("k", c.load)).value, 1);
  clock.tick(1);
  assert.equal((await cache.get("k", c.load)).value, 2);
  assert.equal(c.calls(), 2);
});

test("concurrent misses share one load (single flight)", async () => {
  const { cache } = setup();
  let release!: (v: number) => void;
  let calls = 0;
  const load = () => {
    calls++;
    return new Promise<number>((r) => (release = r));
  };
  const a = cache.get("k", load);
  const b = cache.get("k", load);
  release(7);
  assert.deepEqual([(await a).value, (await b).value], [7, 7]);
  assert.equal(calls, 1);
});

test("a failed refresh serves the last value as stale while within maxStale", async () => {
  const { cache, clock } = setup();
  await cache.get("k", async () => 5);
  clock.tick(2_000);
  const cause = new Error("down");
  const r = await cache.get("k", fail(cause));
  assert.deepEqual(r, { value: 5, fetchedAt: 1_000_000, stale: true, error: cause });
  // during backoff the same failure is reported with the stale value
  assert.equal((await cache.get("k", fail())).error, cause);
});

test("too-old values are dropped and the failure is raised", async () => {
  const { cache, clock } = setup();
  await cache.get("k", async () => 5);
  clock.tick(10_001);
  const cause = new Error("down");
  await assert.rejects(cache.get("k", fail(cause)), (e: unknown) => e instanceof CacheUnavailableError && e.cause === cause);
  // nothing usable remains even after backoff, until a load succeeds
  clock.tick(600);
  await assert.rejects(cache.get("k", fail()), CacheUnavailableError);
  clock.tick(600);
  assert.equal((await cache.get("k", async () => 9)).value, 9);
});

test("no request is made during backoff; a longer hint from the error is honoured", async () => {
  const { cache, clock } = setup();
  await assert.rejects(cache.get("k", fail()), CacheUnavailableError);
  const c = counter();
  clock.tick(499);
  await assert.rejects(cache.get("k", c.load), CacheUnavailableError);
  assert.equal(c.calls(), 0);
  clock.tick(1);
  assert.equal((await cache.get("k", c.load)).value, 1);

  // rate limited: the error's backoff (60 s) beats the policy's 500 ms
  const s = setup();
  await s.cache.get("r", async () => 1);
  s.clock.tick(1_001);
  const limited = new CmcError("RATE_LIMITED", "quotes", { httpStatus: 429, backoffMs: 60_000 });
  assert.equal((await s.cache.get("r", fail(limited))).stale, true);
  const c2 = counter();
  s.clock.tick(5_000);
  assert.equal((await s.cache.get("r", c2.load)).stale, true);
  assert.equal(c2.calls(), 0);
});

test("keys are independent", async () => {
  const { cache } = setup();
  await cache.get("a", async () => 1);
  assert.equal((await cache.get("b", async () => 2)).value, 2);
  assert.equal((await cache.get("a", async () => 3)).value, 1);
});

test("memory store evicts the oldest entry beyond its limit", () => {
  const s = new MemoryStore<number>(2);
  s.set("a", { value: 1, fetchedAt: 0 });
  s.set("b", { value: 2, fetchedAt: 0 });
  s.set("c", { value: 3, fetchedAt: 0 });
  assert.equal(s.size, 2);
  assert.equal(s.get("a"), undefined);
});

test("invalid policies are refused", () => {
  assert.throws(() => new TtlCache({ ttlMs: 0, maxStaleMs: 1, backoffMs: 0 }), RangeError);
  assert.throws(() => new TtlCache({ ttlMs: 10, maxStaleMs: 5, backoffMs: 0 }), RangeError);
});

test("default policies keep credit use within the planned monthly budget", () => {
  const month = 30 * 24 * 3600_000;
  // map costs 0 credits; quotes (<= 60 ids), global and fear & greed cost 1 per call
  // Basic plan: 15,000 credits/month.
  // 2,880 (quotes, 15 min) + 1,440 (global, 30 min) + 720 (fear & greed, 60 min) = 5,040 credits/month per process
  const credits = [POLICIES.quotes, POLICIES.global, POLICIES.fearGreed].reduce((s, p) => s + month / p.ttlMs, 0);
  assert.equal(credits, 5_040);
  assert.ok(credits * 2 <= 15_000, `${credits} credits/month: two processes must fit the Basic plan`);
  for (const p of Object.values(POLICIES)) assert.ok(p.maxStaleMs > p.ttlMs);
});
