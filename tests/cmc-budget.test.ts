// Per-process daily credit cap. Fake clock, no network. [CMC Hackathon, C6-A]

import assert from "node:assert/strict";
import { test } from "node:test";
import { CreditBudget, DAILY_CREDIT_CAP } from "@/lib/cmc/budget";
import { POLICIES } from "@/lib/cmc/cache";

const DAY = 86_400_000;
const T0 = Date.UTC(2030, 0, 1, 23, 0, 0);

test("reservations stop at the cap and reset at 00:00 UTC", () => {
  let now = T0;
  const b = new CreditBudget(3, () => now);
  assert.equal(b.tryReserve(2), true);
  assert.equal(b.tryReserve(2), false); // would exceed; nothing reserved
  assert.equal(b.usedToday, 2);
  assert.equal(b.tryReserve(1), true);
  assert.equal(b.tryReserve(1), false);
  assert.equal(b.msUntilReset(), 3600_000);
  now += 3600_000; // 00:00 UTC next day
  assert.equal(b.usedToday, 0);
  assert.equal(b.tryReserve(3), true);
});

test("invalid amounts are refused; invalid caps rejected", () => {
  const b = new CreditBudget(10, () => T0);
  for (const n of [-1, 1.5, Number.NaN]) assert.equal(b.tryReserve(n), false);
  assert.equal(b.usedToday, 0);
  assert.throws(() => new CreditBudget(-1));
  assert.throws(() => new CreditBudget(1.5));
});

test("the default cap allows a normal day and stays far below the Basic plan", () => {
  // normal day at the cache TTLs: 96 quotes + 48 global + 24 fear & greed = 168 credits
  const normal = [POLICIES.quotes, POLICIES.global, POLICIES.fearGreed].reduce((s, p) => s + DAY / p.ttlMs, 0);
  assert.equal(normal, 168);
  assert.ok(DAILY_CREDIT_CAP >= normal, "the cap must not cut a normal day short");
  // one process, 31 days at the cap: 6,200 < 15,000 (Basic plan monthly credits)
  assert.ok(DAILY_CREDIT_CAP * 31 <= 15_000 / 2, "two processes at the cap must still fit the Basic plan");
});
