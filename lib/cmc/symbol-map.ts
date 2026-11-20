// Binance USD-M perpetual symbol -> CoinMarketCap ID. [CMC Hackathon — new integration]
//
// Mapping is deliberately conservative: a wrong match would attach another
// asset's market cap to a scanner row, which is worse than showing nothing.
//
//   1. Parse the contract: strip the USDT quote, then a unit multiplier prefix
//      (1000PEPE = 1000 PEPE per contract unit), then apply a known alias
//      (a few contracts use a different ticker than the asset's CMC symbol).
//   2. Look the base symbol up in the CMC ID map (active listings only).
//   3. Exactly one active match  -> mapped ("unique").
//      A pinned CMC ID           -> mapped ("pin"), but only if the ID exists
//                                   in the map with the same symbol.
//      Several matches, no pin   -> AMBIGUOUS, no context shown.
//      No match                  -> UNMAPPED, no context shown.
//
// CMC itself advises using IDs rather than symbols; symbols are only the
// lookup key here, and every displayed value is fetched by ID.

import type { CmcMapItem } from "@/lib/cmc/raw";

const CONTRACT_RE = /^([A-Z0-9]{1,24})USDT$/;
// Longest prefix first. "1M" is Binance's notation for one million units.
const MULTIPLIER_PREFIXES: readonly (readonly [string, number])[] = [
  ["1000000", 1_000_000],
  ["1M", 1_000_000],
  ["1000", 1_000],
];

/**
 * Contracts whose base ticker differs from the asset's CMC symbol.
 * Keep this list short and reviewed; C2 verifies each entry against the live map.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  LUNA2: "LUNA",
};

/**
 * Pinned CMC IDs for demo contracts whose ticker is shared by several active
 * CMC listings (copycat tokens). Each pin was verified against the live CMC
 * map in C2 (2026-11-19): it is the clearly top-ranked candidate for that
 * ticker. A pin only applies if the map still lists that id under the same
 * symbol; otherwise the contract is UNMAPPED (PIN_INVALID), never guessed.
 */
export const DEFAULT_PINS: Readonly<Record<string, number>> = {
  BTCUSDT: 1, // Bitcoin
  ETHUSDT: 1027, // Ethereum
  SOLUSDT: 5426, // Solana
  XRPUSDT: 52, // XRP
  DOGEUSDT: 74, // Dogecoin
  BNBUSDT: 1839, // BNB
  ADAUSDT: 2010, // Cardano
  ARBUSDT: 11841, // Arbitrum
  "1000PEPEUSDT": 24478, // Pepe
  "1000BONKUSDT": 23095, // Bonk
  WIFUSDT: 28752, // dogwifhat
  JUPUSDT: 29210, // Jupiter
  STRKUSDT: 22691, // Starknet
};

export interface ParsedContract {
  contract: string;
  base: string; // CMC lookup symbol
  multiplier: number; // asset units per contract unit
}

export type UnparsedReason = "NOT_USDT_CONTRACT" | "UNSUPPORTED_CHARS";

export function parseContract(
  contract: string,
  aliases: Readonly<Record<string, string>> = DEFAULT_ALIASES,
): ParsedContract | { contract: string; reason: UnparsedReason } {
  if (!contract.endsWith("USDT") || contract.length <= 4) return { contract, reason: "NOT_USDT_CONTRACT" };
  const m = CONTRACT_RE.exec(contract);
  if (!m) return { contract, reason: "UNSUPPORTED_CHARS" }; // e.g. CJK-named contracts
  let base = m[1];
  let multiplier = 1;
  for (const [prefix, factor] of MULTIPLIER_PREFIXES) {
    const rest = base.slice(prefix.length);
    // only a prefix if a ticker starting with a letter remains (1INCH is not 1 x INCH)
    if (base.startsWith(prefix) && /^[A-Z]/.test(rest)) {
      base = rest;
      multiplier = factor;
      break;
    }
  }
  base = aliases[base] ?? base;
  return { contract, base, multiplier };
}

export type Mapping =
  | {
      status: "MAPPED";
      contract: string;
      via: "unique" | "pin";
      cmc_id: number;
      cmc_symbol: string;
      name: string;
      slug: string;
      multiplier: number;
    }
  | { status: "AMBIGUOUS"; contract: string; candidates: number }
  | { status: "UNMAPPED"; contract: string; reason: UnparsedReason | "NO_MATCH" | "PIN_INVALID" };

export interface MapOptions {
  aliases?: Readonly<Record<string, string>>;
  pins?: Readonly<Record<string, number>>;
}

/** CMC symbols to request from /v1/cryptocurrency/map for these contracts (deduplicated). */
export function lookupSymbols(contracts: readonly string[], opts: MapOptions = {}): string[] {
  const out = new Set<string>();
  for (const c of contracts) {
    const p = parseContract(c, opts.aliases);
    if ("base" in p) out.add(p.base);
  }
  return [...out].sort();
}

/** Maps every contract; the result has one entry per input contract, in input order. */
export function mapContracts(
  contracts: readonly string[],
  mapItems: readonly CmcMapItem[],
  opts: MapOptions = {},
): Mapping[] {
  const pins = opts.pins ?? DEFAULT_PINS;
  const bySymbol = new Map<string, CmcMapItem[]>();
  for (const item of mapItems) {
    if (item.is_active === 0) continue;
    const list = bySymbol.get(item.symbol) ?? [];
    list.push(item);
    bySymbol.set(item.symbol, list);
  }

  return contracts.map((contract): Mapping => {
    const p = parseContract(contract, opts.aliases);
    if (!("base" in p)) return { status: "UNMAPPED", contract, reason: p.reason };
    const candidates = bySymbol.get(p.base) ?? [];
    const pinned = pins[contract];
    let chosen: CmcMapItem | undefined;
    let via: "unique" | "pin" = "unique";
    if (pinned !== undefined) {
      chosen = candidates.find((c) => c.id === pinned);
      if (!chosen) return { status: "UNMAPPED", contract, reason: "PIN_INVALID" };
      via = "pin";
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    } else if (candidates.length > 1) {
      return { status: "AMBIGUOUS", contract, candidates: candidates.length };
    } else {
      return { status: "UNMAPPED", contract, reason: "NO_MATCH" };
    }
    return {
      status: "MAPPED",
      contract,
      via,
      cmc_id: chosen.id,
      cmc_symbol: chosen.symbol,
      name: chosen.name,
      slug: chosen.slug,
      multiplier: p.multiplier,
    };
  });
}
