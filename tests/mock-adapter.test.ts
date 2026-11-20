// Mock adapter + scenarios: deterministic, validated, and the states the UI depends on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SchemaValidationError } from "../lib/data/adapter";
import { createMockAdapter } from "../lib/data/mock-adapter";
import { SIM_EPOCH_MS, fixedClock, simClock } from "../lib/data/sim-clock";
import {
  MOCK_CONNECTIONS,
  MOCK_SYMBOLS,
  MOCK_SYMBOLS_SCANNED,
  SCENARIOS,
  STALE_AGE_S,
  scenarioSnapshot,
} from "../lib/mock/scenarios";
import { freshness } from "../lib/scanner/freshness";

const get = (scenario: (typeof SCENARIOS)[number], ms = SIM_EPOCH_MS) =>
  createMockAdapter({ scenario, clock: fixedClock(ms) }).getLatest();

test("36 placeholder symbols; adapter kind is mock", async () => {
  assert.equal(MOCK_SYMBOLS.length, 36);
  assert.equal(new Set(MOCK_SYMBOLS).size, 36);
  const a = createMockAdapter();
  assert.equal(a.kind, "mock");
  assert.equal((await a.getLatest()).source, "mock");
});

test("deterministic: same simulated time -> identical snapshot", () => {
  for (const s of SCENARIOS) {
    assert.deepEqual(scenarioSnapshot(s, SIM_EPOCH_MS + 12_345), scenarioSnapshot(s, SIM_EPOCH_MS + 12_345), s);
  }
});

test("simulated clock starts at the fictional 2030 epoch and advances in real time", () => {
  let real = 1_000_000;
  const c = simClock(real, () => real);
  assert.equal(c.now(), SIM_EPOCH_MS);
  assert.equal(new Date(SIM_EPOCH_MS).getUTCFullYear(), 2030);
  real += 42_000;
  assert.equal(c.now(), SIM_EPOCH_MS + 42_000);
});

test("normal: fresh (LIVE level), rows present, some low-liquidity flags and one pending row", async () => {
  const { snapshot } = await get("normal");
  assert.equal(freshness(snapshot, SIM_EPOCH_MS).level, "LIVE");
  assert.ok(snapshot.rows.length >= 30);
  assert.ok(snapshot.rows.some((r) => r.data_flags.includes("LOW_LIQUIDITY")));
  assert.equal(snapshot.rows.filter((r) => r.structure_pending).length, 1);
});

test("high_vr14: the volume ranking is led by >= 100x events", async () => {
  const { snapshot } = await get("high_vr14");
  const top = snapshot.rows.find((r) => r.symbol === snapshot.rankings.volume[0])!;
  assert.ok(top.event.vr14! >= 100, String(top.event.vr14));
});

test("stale: generated 600 s before now -> DELAYED", async () => {
  const { snapshot } = await get("stale");
  assert.equal(snapshot.generated_ms, SIM_EPOCH_MS - STALE_AGE_S * 1000);
  const f = freshness(snapshot, SIM_EPOCH_MS);
  assert.equal(f.level, "DELAYED");
  assert.equal(f.age_s, STALE_AGE_S);
});

test("empty: valid snapshot with no rows and no matches", async () => {
  const { snapshot } = await get("empty");
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.matching, 0);
  assert.deepEqual(snapshot.rankings, { recent: [], volume: [] });
});

test("pending: most rows have trends null and no conflict/aligned guess", async () => {
  const { snapshot } = await get("pending");
  const pending = snapshot.rows.filter((r) => r.structure_pending);
  assert.ok(pending.length > snapshot.rows.length / 2);
  for (const r of pending) {
    assert.equal(r.trends, null);
    assert.equal(r.conflict, null);
    assert.equal(r.aligned, null);
  }
});

test("low_liquidity: every row carries a thin-market flag, all still >= 500K 24H", async () => {
  const { snapshot } = await get("low_liquidity");
  for (const r of snapshot.rows) {
    assert.ok(r.data_flags.length > 0, r.symbol);
    assert.ok(r.qv_24h.usdt! >= 500_000 && r.qv_24h.usdt! < 6_000_000, r.symbol);
  }
});

test("partial: 2 of 3 connections -> PARTIAL, never LIVE", async () => {
  const { snapshot } = await get("partial");
  assert.equal(snapshot.scanner.connections_up, 2);
  assert.equal(snapshot.scanner.connections_total, 3);
  const f = freshness(snapshot, SIM_EPOCH_MS);
  assert.equal(f.level, "PARTIAL");
  assert.equal(f.reason, "CONNECTIONS");
});

test("scanner-health figures are the fictional mock values", async () => {
  const { snapshot } = await get("normal");
  assert.equal(snapshot.scanner.symbols_scanned, MOCK_SYMBOLS_SCANNED);
  assert.equal(snapshot.scanner.connections_total, MOCK_CONNECTIONS);
  assert.equal(snapshot.scanner.connections_up, MOCK_CONNECTIONS);
});

test("invalid: the adapter rejects it with SchemaValidationError (never displayed)", async () => {
  await assert.rejects(get("invalid"), (e: unknown) => {
    assert.ok(e instanceof SchemaValidationError);
    assert.ok(e.issues.length >= 2);
    assert.ok(e.issues.some((i) => /vr14/.test(i.path)));
    return true;
  });
});

test("freshness: clock skew and stopped scanner are never LIVE", async () => {
  const { snapshot } = await get("normal");
  assert.equal(freshness(snapshot, SIM_EPOCH_MS - 120_000).level, "CLOCK");
  assert.equal(freshness({ ...snapshot, scanner: { ...snapshot.scanner, state: "ENDED" } }, SIM_EPOCH_MS).level, "STOPPED");
  assert.equal(freshness(snapshot, SIM_EPOCH_MS + 181_000).level, "DELAYED");
  assert.equal(freshness(snapshot, SIM_EPOCH_MS + 179_000).level, "LIVE");
  assert.equal(
    freshness({ ...snapshot, volume_feed: { ticker_state: "STALE", ticker_fetched_at: null } }, SIM_EPOCH_MS).reason,
    "TICKER",
  );
});
