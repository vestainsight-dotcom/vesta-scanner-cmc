// Binance contract -> CMC ID mapping. Synthetic map data only. [CMC Hackathon]

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PINS, lookupSymbols, mapContracts, parseContract } from "@/lib/cmc/symbol-map";
import { mapResponseSchema } from "@/lib/cmc/raw";
import { MOCK_SYMBOLS } from "@/lib/mock/scenarios";
import { mapBody, type MapRow } from "./fixtures/cmc";

const items = (rows: MapRow[]) => mapResponseSchema.parse(mapBody(rows)).data;

test("parses plain, multiplier, alias and digit-led contracts", () => {
  assert.deepEqual(parseContract("BTCUSDT"), { contract: "BTCUSDT", base: "BTC", multiplier: 1 });
  assert.deepEqual(parseContract("1000PEPEUSDT"), { contract: "1000PEPEUSDT", base: "PEPE", multiplier: 1000 });
  assert.deepEqual(parseContract("1000000MOGUSDT"), { contract: "1000000MOGUSDT", base: "MOG", multiplier: 1_000_000 });
  assert.deepEqual(parseContract("1MBABYDOGEUSDT"), { contract: "1MBABYDOGEUSDT", base: "BABYDOGE", multiplier: 1_000_000 });
  // a ticker that merely starts with a digit is not a multiplier
  assert.deepEqual(parseContract("1INCHUSDT"), { contract: "1INCHUSDT", base: "1INCH", multiplier: 1 });
  assert.deepEqual(parseContract("LUNA2USDT"), { contract: "LUNA2USDT", base: "LUNA", multiplier: 1 });
  assert.deepEqual(parseContract("ABCUSDT", { ABC: "XYZ" }), { contract: "ABCUSDT", base: "XYZ", multiplier: 1 });
});

test("rejects non-USDT and unsupported contracts", () => {
  assert.deepEqual(parseContract("BTCUSDC"), { contract: "BTCUSDC", reason: "NOT_USDT_CONTRACT" });
  assert.deepEqual(parseContract("USDT"), { contract: "USDT", reason: "NOT_USDT_CONTRACT" });
  assert.deepEqual(parseContract("币安人生USDT"), { contract: "币安人生USDT", reason: "UNSUPPORTED_CHARS" });
  assert.deepEqual(parseContract("btcusdt"), { contract: "btcusdt", reason: "NOT_USDT_CONTRACT" });
});

test("every demo contract parses to a lookup symbol", () => {
  for (const s of MOCK_SYMBOLS) assert.ok("base" in parseContract(s), s);
  const syms = lookupSymbols(MOCK_SYMBOLS);
  assert.ok(syms.includes("PEPE") && syms.includes("BONK") && !syms.includes("1000PEPE"));
  assert.equal(new Set(syms).size, syms.length);
});

test("unique active match maps; inactive listings are ignored", () => {
  const map = items([
    { id: 900001, symbol: "AAA", rank: 10 },
    { id: 900002, symbol: "AAA", rank: 900, is_active: 0 },
  ]);
  const [m] = mapContracts(["AAAUSDT"], map);
  assert.equal(m.status, "MAPPED");
  if (m.status === "MAPPED") {
    assert.equal(m.cmc_id, 900001);
    assert.equal(m.via, "unique");
    assert.equal(m.multiplier, 1);
  }
});

test("several active matches without a pin are AMBIGUOUS, never guessed by rank", () => {
  const map = items([
    { id: 900011, symbol: "DUP", rank: 5 },
    { id: 900012, symbol: "DUP", rank: 3000 },
  ]);
  assert.deepEqual(mapContracts(["DUPUSDT"], map), [{ status: "AMBIGUOUS", contract: "DUPUSDT", candidates: 2 }]);
});

test("a pin resolves ambiguity only if the pinned id exists with that symbol", () => {
  const map = items([
    { id: 900011, symbol: "DUP", rank: 5 },
    { id: 900012, symbol: "DUP", rank: 3000 },
    { id: 900013, symbol: "OTHER" },
  ]);
  const [ok] = mapContracts(["DUPUSDT"], map, { pins: { DUPUSDT: 900012 } });
  assert.equal(ok.status === "MAPPED" && ok.cmc_id === 900012 && ok.via === "pin", true);
  // pinned id belongs to a different symbol -> refused
  assert.deepEqual(mapContracts(["DUPUSDT"], map, { pins: { DUPUSDT: 900013 } }), [
    { status: "UNMAPPED", contract: "DUPUSDT", reason: "PIN_INVALID" },
  ]);
  // pinned id missing from the map
  assert.deepEqual(mapContracts(["DUPUSDT"], map, { pins: { DUPUSDT: 999999 } }), [
    { status: "UNMAPPED", contract: "DUPUSDT", reason: "PIN_INVALID" },
  ]);
});

test("no match and unparsable contracts are UNMAPPED; output keeps input order", () => {
  const map = items([{ id: 24478, symbol: "PEPE" }]);
  const out = mapContracts(["NONEUSDT", "1000PEPEUSDT", "BTCUSDC"], map);
  assert.deepEqual(
    out.map((m) => [m.contract, m.status]),
    [
      ["NONEUSDT", "UNMAPPED"],
      ["1000PEPEUSDT", "MAPPED"],
      ["BTCUSDC", "UNMAPPED"],
    ],
  );
  const pepe = out[1];
  assert.equal(pepe.status === "MAPPED" && pepe.multiplier, 1000);
});

test("exactly the 13 pins verified in C2 ship, all for demo contracts", () => {
  assert.deepEqual(DEFAULT_PINS, {
    BTCUSDT: 1,
    ETHUSDT: 1027,
    SOLUSDT: 5426,
    XRPUSDT: 52,
    DOGEUSDT: 74,
    BNBUSDT: 1839,
    ADAUSDT: 2010,
    ARBUSDT: 11841,
    "1000PEPEUSDT": 24478,
    "1000BONKUSDT": 23095,
    WIFUSDT: 28752,
    JUPUSDT: 29210,
    STRKUSDT: 22691,
  });
  for (const c of Object.keys(DEFAULT_PINS)) assert.ok((MOCK_SYMBOLS as readonly string[]).includes(c), c);
});

test("default pins resolve copycat tickers to the pinned id", () => {
  // synthetic map: the pinned id plus a copycat with the same symbol
  const map = items([
    { id: 1, symbol: "BTC", rank: 1 },
    { id: 900301, symbol: "BTC", rank: 3000 },
    { id: 24478, symbol: "PEPE", rank: 41 },
    { id: 900302, symbol: "PEPE", rank: 4000 },
  ]);
  const [btc, pepe] = mapContracts(["BTCUSDT", "1000PEPEUSDT"], map);
  assert.ok(btc.status === "MAPPED" && btc.cmc_id === 1 && btc.via === "pin");
  assert.ok(pepe.status === "MAPPED" && pepe.cmc_id === 24478 && pepe.multiplier === 1000);
  // a pinned id that vanished from the map is never replaced by a copycat
  const gone = items([{ id: 900301, symbol: "BTC", rank: 3000 }]);
  assert.deepEqual(mapContracts(["BTCUSDT"], gone), [{ status: "UNMAPPED", contract: "BTCUSDT", reason: "PIN_INVALID" }]);
});
