// C4: CMC context on the demo page. Synthetic contexts only, no network; the
// real components are rendered with react-dom/server. [CMC Hackathon]

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CmcRowCells, CMC_COLUMN_COUNT, CMC_TINT } from "@/components/cmc-cells";
import { CmcContextPanel } from "@/components/cmc-context-panel";
import { DemoApp } from "@/components/demo-app";
import { ScannerBoard, SourceLegend } from "@/components/scanner-board";
import { CMC_CONTEXT_PATH, loadCmcContext, type CmcLoad } from "@/lib/data/cmc-context-client";
import { assetsBySymbol, cmcBadges, fearGreedClass, formatPp, formatShare, formatUsdCompact, usableContext } from "@/lib/data/cmc-view";
import { DEFAULT_LOCALE, LOCALES, MESSAGES } from "@/lib/i18n/messages";
import { MOCK_SYMBOLS } from "@/lib/mock/scenarios";
import { ATTRIBUTION, CMC_CONTEXT_SCHEMA, REASONS, TIERS, cmcContextSchema, tierOf, type CmcAsset, type CmcContext } from "@/lib/schema/cmc-context-v1";

const en = MESSAGES.en;
const zh = MESSAGES["zh-Hant"];
/** the server render (and a first visit without a saved choice) uses the default locale */
const dm = MESSAGES[DEFAULT_LOCALE];

// ---- synthetic, schema-valid contexts ----
const okAsset = (symbol: string, i: number): CmcAsset => {
  const rank = [3, 75, 640, 2400][i % 4];
  return {
    symbol,
    state: "OK",
    cmc_id: 900_000 + i,
    cmc_symbol: symbol.replace(/^1000/, "").replace(/USDT$/, ""),
    name: `Synthetic ${i}`,
    multiplier: symbol.startsWith("1000") ? 1000 : 1,
    rank,
    tier: tierOf(rank),
    price_usd: 1.25,
    market_cap_usd: 3_210_000_000,
    volume_24h_usd: 45_600_000,
    change_24h_pct: i % 2 ? -2.345 : 1.5,
    change_7d_pct: 12.3,
    updated_at: "2026-11-19T11:59:00Z",
  };
};
function ctx(over: Partial<CmcContext> = {}): CmcContext {
  const c: CmcContext = {
    schema: CMC_CONTEXT_SCHEMA,
    status: "ok",
    reason: null,
    generated_at: "2026-11-19T12:00:00Z",
    as_of: "2026-11-19T11:58:30Z",
    stale: false,
    scanner_rows: "SIMULATED",
    attribution: { ...ATTRIBUTION },
    backdrop: {
      total_market_cap_usd: 3_050_000_000_000,
      total_volume_24h_usd: 121_000_000_000,
      btc_dominance_pct: 56.2,
      btc_dominance_change_24h_pct: -0.4,
      derivatives_volume_24h_usd: 900_000_000_000,
      updated_at: "2026-11-19T11:55:00Z",
      fear_greed: { value: 61, classification: "Greed", updated_at: "2026-11-19T11:45:00Z" },
    },
    assets: MOCK_SYMBOLS.map((s, i) => okAsset(s, i)),
    ...over,
  };
  assert.equal(cmcContextSchema.safeParse(c).success, true, JSON.stringify(cmcContextSchema.safeParse(c).error?.issues));
  return c;
}
const loaded = (c: CmcContext): CmcLoad => ({ kind: "loaded", ctx: c });
const UNAVAILABLE = (reason: CmcContext["reason"]): CmcContext => ({
  schema: CMC_CONTEXT_SCHEMA,
  status: "unavailable",
  reason,
  generated_at: "2026-11-19T12:00:00Z",
  as_of: null,
  stale: false,
  scanner_rows: "SIMULATED",
  attribution: { ...ATTRIBUTION },
  backdrop: null,
  assets: [],
});

const panel = (load: CmcLoad, m = en) => renderToStaticMarkup(createElement(CmcContextPanel, { load, m }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const badgesIn = (html: string) => [...html.matchAll(/data-badge="([A-Z]+)"/g)].map((x) => x[1]);

// ---------- view model ----------
test("badges: LIVE, STALE, PARTIAL, UNAVAILABLE, LOADING", () => {
  assert.deepEqual(cmcBadges({ kind: "loading" }), ["LOADING"]);
  assert.deepEqual(cmcBadges(loaded(ctx())), ["LIVE"]);
  assert.deepEqual(cmcBadges(loaded(ctx({ status: "partial", reason: "PLAN_FORBIDDEN" }))), ["LIVE", "PARTIAL"]);
  assert.deepEqual(cmcBadges(loaded(ctx({ status: "partial", reason: "RATE_LIMITED", stale: true }))), ["LIVE", "STALE", "PARTIAL"]);
  assert.deepEqual(cmcBadges(loaded(UNAVAILABLE("NO_KEY"))), ["UNAVAILABLE"]);
  assert.deepEqual(cmcBadges({ kind: "error", error: "NETWORK" }), ["UNAVAILABLE"]);
});

test("rows are enriched only when the context has at least one matched asset", () => {
  assert.equal(assetsBySymbol({ kind: "loading" }), null);
  assert.equal(assetsBySymbol(loaded(UNAVAILABLE("NO_KEY"))), null);
  assert.equal(assetsBySymbol(loaded(ctx({ assets: [{ symbol: "BTCUSDT", state: "NO_QUOTE" }] }))), null);
  assert.equal(assetsBySymbol(loaded(ctx()))?.get("BTCUSDT")?.state, "OK");
  assert.equal(usableContext(loaded(UNAVAILABLE("TIMEOUT"))), null);
});

test("formatting", () => {
  assert.deepEqual(
    [3.05e12, 812.4e9, 45.2e6, 9_900, 12, null].map(formatUsdCompact),
    ["$3.05T", "$812.40B", "$45.20M", "$9.9K", "$12", "—"],
  );
  assert.deepEqual([formatShare(56.2), formatShare(null), formatPp(0.4), formatPp(-0.001), formatPp(null)], ["56.20%", "—", "+0.40 pp", "0.00 pp", "—"]);
  assert.deepEqual(
    ["Extreme fear", "greed", "EXTREME GREED", "Neutral", "Mystery"].map(fearGreedClass),
    ["EXTREME_FEAR", "GREED", "EXTREME_GREED", "NEUTRAL", null],
  );
});

// ---------- browser reader ----------
function fakeFetch(status: number, body: string | (() => never)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (typeof body === "function") body();
    return new Response(body as string, { status });
  };
  return { fetchImpl, calls };
}

test("reader: same-origin GET, no cache, no credentials beyond same-origin, no key header", async () => {
  const f = fakeFetch(200, JSON.stringify(ctx()));
  const r = await loadCmcContext(f.fetchImpl);
  assert.equal(r.kind, "loaded");
  const [{ url, init }] = f.calls;
  assert.equal(url, CMC_CONTEXT_PATH);
  assert.equal(url, "/api/cmc/context");
  assert.deepEqual([init.method, init.cache, init.credentials], ["GET", "no-store", "same-origin"]);
  assert.deepEqual(init.headers, { Accept: "application/json" });
});

test("reader: 503 unavailable body is a valid, renderable state", async () => {
  const r = await loadCmcContext(fakeFetch(503, JSON.stringify(UNAVAILABLE("NO_KEY"))).fetchImpl);
  assert.ok(r.kind === "loaded" && r.ctx.status === "unavailable" && r.ctx.reason === "NO_KEY");
});

test("reader: anything that is not a valid context is rejected, never rendered", async () => {
  const bad: [number, string][] = [
    [500, JSON.stringify(ctx())], // unexpected status
    [200, "not json"],
    [200, JSON.stringify({ ...ctx(), extra: 1 })], // strict schema
    [200, JSON.stringify({ ...ctx(), scanner_rows: "LIVE" })], // scanner rows can never be labelled live
    [200, JSON.stringify({ ...ctx(), as_of: null })], // data without its timestamp
    [200, "x".repeat(200_001)],
  ];
  for (const [status, body] of bad) {
    assert.deepEqual(await loadCmcContext(fakeFetch(status, body).fetchImpl), { kind: "error", error: "INVALID" }, body.slice(0, 40));
  }
  const down = fakeFetch(200, () => {
    throw new TypeError("offline");
  });
  assert.deepEqual(await loadCmcContext(down.fetchImpl), { kind: "error", error: "NETWORK" });
});

// ---------- panel rendering ----------
test("panel (ok): REAL CMC DATA, market cap, dominance, fear & greed, as_of, attribution", () => {
  const html = panel(loaded(ctx()));
  const t = text(html);
  assert.deepEqual(badgesIn(html), ["LIVE"]);
  assert.match(t, /REAL CMC DATA/);
  assert.match(t, /Total crypto market cap \$3\.05T/);
  assert.match(t, /24H total volume \$121\.00B/);
  assert.match(t, /BTC dominance 56\.20%/);
  assert.match(t, /24H change -0\.40 pp/);
  assert.match(t, /Fear & Greed Index 61 Greed/);
  // as_of 11:58:30Z shown in UTC+8, labelled as real (not simulated) time
  assert.match(t, /CMC snapshot as of 2026-11-19 19:58:30 \(UTC\+8\) · cached on the server, refreshed every 15–60 min, not real-time/);
  assert.doesNotMatch(t, /simulated time/);
  // exact required attribution, linked, near the top of the panel (right under the title)
  assert.match(html, /href="https:\/\/coinmarketcap\.com"[^>]*rel="noopener noreferrer"[^>]*>Data provided by CoinMarketCap\.com<\/a>/);
  assert.ok(html.indexOf('data-testid="cmc-attribution"') < html.indexOf('data-testid="cmc-market-cap"'));
  assert.equal((html.match(/data-testid="cmc-note"/g) ?? []).length, 0);
});

test("panel (stale + partial): both labels, the reason and the stale note", () => {
  const t = text(panel(loaded(ctx({ status: "partial", reason: "RATE_LIMITED", stale: true }))));
  assert.match(t, /REAL CMC DATA STALE PARTIAL/);
  assert.match(t, /CMC request limit reached/);
  assert.match(t, /Some values are from the last successful update/);
  assert.match(t, /CMC snapshot as of 2026-11-19 19:58:30/); // the original fetch time, not "now"
});

test("panel (unavailable, e.g. no key): no numbers, reason, scanner unaffected, attribution kept", () => {
  for (const reason of ["NO_KEY", "UNAUTHORIZED", "DISABLED"] as const) {
    const html = panel(loaded(UNAVAILABLE(reason)));
    const t = text(html);
    assert.deepEqual(badgesIn(html), ["UNAVAILABLE"]);
    assert.ok(t.includes(en.cmc.reasons[reason]), reason);
    assert.match(t, /scanner demo is unaffected/);
    assert.doesNotMatch(html, /data-testid="cmc-market-cap"|data-testid="cmc-as-of-label"/);
    assert.match(t, /Data provided by CoinMarketCap\.com/);
  }
  const invalid = text(panel({ kind: "error", error: "INVALID" }));
  assert.match(invalid, /failed validation and was not displayed/);
});

test("panel (loading): only the loading label", () => {
  const html = panel({ kind: "loading" });
  assert.deepEqual(badgesIn(html), ["LOADING"]);
  assert.doesNotMatch(html, /data-testid="cmc-note"|data-testid="cmc-market-cap"/);
});

test("panel (missing fields): 'Not available' instead of invented values", () => {
  const c = ctx({
    status: "partial",
    reason: "PLAN_FORBIDDEN",
    backdrop: {
      total_market_cap_usd: null,
      total_volume_24h_usd: null,
      btc_dominance_pct: null,
      btc_dominance_change_24h_pct: null,
      derivatives_volume_24h_usd: null,
      updated_at: null,
      fear_greed: null,
    },
  });
  const t = text(panel(loaded(c)));
  assert.equal((t.match(/Not available/g) ?? []).length, 3);
  assert.doesNotMatch(t, /\$0|NaN|undefined|null/);
  // no backdrop at all: stats still render as not available
  assert.equal((text(panel(loaded(ctx({ status: "partial", reason: "TIMEOUT", backdrop: null })))).match(/Not available/g) ?? []).length, 3);
});

test("panel: unknown fear & greed wording is shown as CMC wrote it; zh translates known ones", () => {
  const odd = ctx();
  odd.backdrop!.fear_greed = { value: 50, classification: "Mystery", updated_at: null };
  assert.match(text(panel(loaded(odd))), /Fear & Greed Index 50 Mystery/);
  assert.match(text(panel(loaded(ctx()), zh)), /恐懼與貪婪指數 61 貪婪/);
});

// ---------- table enrichment ----------
const board =(cmc: Map<string, CmcAsset> | null) => renderToStaticMarkup(createElement(ScannerBoard, { cmcAssets: cmc }));

test("board without CMC renders exactly as before: no CMC columns, simulated tag only", () => {
  const html = board(null);
  assert.doesNotMatch(html, /data-cmc=/);
  assert.match(html, /data-testid="tag-simulated"/);
  assert.doesNotMatch(html, /data-testid="tag-live"/);
  assert.ok(html.includes(MESSAGES["zh-Hant"].demo.bannerTitle)); // the demo banner is still there
});

test("board with CMC: four labelled live columns, every live cell tinted, scanner cells not", () => {
  const html = board(assetsBySymbol(loaded(ctx())));
  assert.equal((html.match(/data-cmc="th"/g) ?? []).length, CMC_COLUMN_COUNT);
  const okCells = (html.match(/data-cmc="ok"/g) ?? []).length;
  assert.ok(okCells > 0);
  // every CMC cell (header + 4 per row) carries the live tint, and nothing else does
  const tinted = html.split(CMC_TINT).length - 1;
  const bodyRows = (html.match(/<tr class="border-t/g) ?? []).length;
  assert.equal(tinted, CMC_COLUMN_COUNT * (bodyRows + 1));
  assert.match(html, /data-testid="tag-simulated"/);
  assert.match(html, /data-testid="tag-live"/);
  for (const h of [dm.cmc.table.rank, dm.cmc.table.marketCap, dm.cmc.table.spotVolume]) assert.ok(html.includes(h), h);
});

test("cells: matched asset shows rank, tier, market cap, spot volume, 24H / 7D", () => {
  const a = okAsset("1000PEPEUSDT", 1); // rank 75 -> MID, multiplier 1000
  const t = renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement("tr", null, createElement(CmcRowCells, { asset: a, m: en })))));
  assert.match(t, /#75/);
  assert.match(t, /data-tier="MID"/);
  assert.match(t, />51–200</);
  assert.match(t, /\$3\.21B/);
  assert.match(t, /\$45\.60M/);
  assert.match(t, /-2\.35%/);
  assert.match(t, /\+12\.30%/);
  assert.match(t, /title="1 contract unit = 1,000 tokens"/);
});

test("cells: unmatched, ambiguous, no-quote and missing assets show a label, never numbers", () => {
  const cell = (asset: CmcAsset | undefined) =>
    renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement("tr", null, createElement(CmcRowCells, { asset, m: en })))));
  const cases: [CmcAsset | undefined, string, string][] = [
    [{ symbol: "XUSDT", state: "AMBIGUOUS" }, "AMBIGUOUS", en.cmc.table.ambiguous],
    [{ symbol: "XUSDT", state: "UNMAPPED" }, "UNMAPPED", en.cmc.table.unmapped],
    [{ symbol: "XUSDT", state: "NO_QUOTE" }, "NO_QUOTE", en.cmc.table.noQuote],
    [undefined, "MISSING", en.cmc.table.unmapped],
  ];
  for (const [asset, state, label] of cases) {
    const html = cell(asset);
    assert.match(html, new RegExp(`data-cmc-state="${state}"`));
    assert.ok(text(html).includes(label));
    assert.doesNotMatch(text(html), /\$|%|#\d/);
  }
});

test("legend separates SIMULATED DEMO DATA from REAL CMC DATA in both locales", () => {
  for (const l of LOCALES) {
    const t = text(renderToStaticMarkup(createElement(SourceLegend, { m: MESSAGES[l], cmc: true })));
    assert.match(t, /SIMULATED DEMO DATA/);
    assert.match(t, /REAL CMC DATA/);
  }
});

test("wherever CMC columns are shown, the exact attribution sits beside the table legend; never without CMC data", () => {
  for (const l of LOCALES) {
    const on = renderToStaticMarkup(createElement(SourceLegend, { m: MESSAGES[l], cmc: true }));
    assert.match(on, /data-testid="cmc-attribution-table"/);
    assert.match(on, /href="https:\/\/coinmarketcap\.com"[^>]*>Data provided by CoinMarketCap\.com<\/a>/);
    const off = renderToStaticMarkup(createElement(SourceLegend, { m: MESSAGES[l], cmc: false }));
    assert.doesNotMatch(off, /cmc-attribution-table/);
  }
});

test("first render (server HTML): CMC still loading, scanner fully usable, no CMC columns yet", () => {
  const html = renderToStaticMarkup(createElement(DemoApp));
  assert.match(html, /data-testid="cmc-panel" data-state="LOADING"/);
  assert.match(html, /data-testid="board"/);
  assert.doesNotMatch(html, /data-cmc=/);
});

// ---------- product principle and i18n ----------
test("CMC UI adds no trading recommendations or scores", () => {
  const html = panel(loaded(ctx({ status: "partial", reason: "RATE_LIMITED", stale: true }))) + board(assetsBySymbol(loaded(ctx())));
  const cmcText = text(html.split('data-testid="board"')[0]) + JSON.stringify(MESSAGES.en.cmc);
  assert.doesNotMatch(cmcText, /\b(buy|sell|long|short|entry|exit|target|score|predict\w*|opportunity score|altcoin season|trending|RWA)\b/i);
  assert.match(MESSAGES.en.cmc.sectionSub, /Not a trading signal/);
});

test("i18n: every CMC reason, tier and badge has words in both locales", () => {
  for (const l of LOCALES) {
    const c = MESSAGES[l].cmc;
    for (const r of REASONS) assert.ok(c.reasons[r], `${l} reason ${r}`);
    for (const t of TIERS) assert.ok(c.tiers[t], `${l} tier ${t}`);
    for (const b of ["LOADING", "LIVE", "STALE", "PARTIAL", "UNAVAILABLE"] as const) assert.ok(c.badges[b], `${l} badge ${b}`);
    assert.match(c.badges.LIVE, /REAL CMC DATA/);
    assert.match(c.sources.scannerTag, /SIMULATED DEMO DATA/);
  }
});

test("demo texts no longer claim the page has no live data at all", () => {
  for (const l of LOCALES) {
    const m = MESSAGES[l];
    assert.match(m.demo.bannerBody, /CoinMarketCap/);
    assert.match(m.disclaimer, /CoinMarketCap/);
    assert.match(m.meta.description, /CoinMarketCap/);
  }
});

// ---------- C5: wording and single timestamp ----------
test("C5: one CMC timestamp only (the original as_of), never presented as real-time", () => {
  for (const l of LOCALES) {
    const html = panel(loaded(ctx()), MESSAGES[l]);
    assert.equal((html.match(/data-testid="cmc-as-of-label"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /data-testid="cmc-as-of"[ >]/); // the old duplicate stat card is gone
    assert.equal((text(html).match(/2026-11-19 19:58:30/g) ?? []).length, 1);
  }
  assert.match(en.cmc.asOf("x"), /not real-time/);
  assert.match(zh.cmc.asOf("x"), /非即時/);
  for (const l of LOCALES) {
    const all = JSON.stringify(MESSAGES[l]);
    assert.doesNotMatch(all, /LIVE CMC DATA|real time\)|即時資料/, l);
  }
});

test("C5: hero states the product principle; activity wording replaces long/short bias", () => {
  for (const l of LOCALES) {
    const m = MESSAGES[l];
    assert.equal(`${m.hero.title} ${m.hero.titleLine2}`, "Discover Market Activity. Identify Potential Opportunities.");
    assert.doesNotMatch(Object.values(m.bias).join(" "), /long|short|bias|偏多|偏空|多|空/i, l);
  }
  assert.deepEqual(en.bias, { LONG: "Upward activity", SHORT: "Downward activity", NEUTRAL: "No clear direction" });
  const html = renderToStaticMarkup(createElement(DemoApp));
  assert.match(text(html), /Discover Market Activity\. Identify Potential Opportunities\./);
  assert.doesNotMatch(text(html), /偏多|偏空|Long bias|Short bias/);
  assert.ok(text(html).includes(dm.bias.LONG) || text(html).includes(dm.bias.SHORT)); // activity words in the default locale
});

test("C5 final: neutral zh trend words everywhere; hero subtitle", () => {
  assert.deepEqual([zh.trend.TREND_UP, zh.trend.TREND_DOWN], ["上行趨勢", "下行趨勢"]);
  assert.deepEqual([zh.conflictDir.UP, zh.conflictDir.DOWN], ["上行趨勢", "下行趨勢"]);
  for (const l of LOCALES) assert.doesNotMatch(JSON.stringify(MESSAGES[l]), /多頭|空頭|偏多|偏空/, l);
  assert.equal(en.hero.subtitle, "Monitor unusual cryptocurrency market activity with contextual market data.");
  assert.equal(zh.hero.subtitle, "結合市場背景資料，監測加密貨幣市場的異常活動。");
  assert.ok(text(renderToStaticMarkup(createElement(DemoApp))).includes(dm.hero.subtitle));
});

// ---------- C6-N: table navigation (horizontal scrolling usability) ----------
test("board navigation: hint, ◀ ▶ buttons tied to the board, left disabled at start (default locale)", () => {
  const html = board(assetsBySymbol(loaded(ctx())));
  const t = dm.table; // the server render uses the default locale
  assert.ok(html.includes(t.swipe) && html.includes(t.scrollHint), "phone and desktop hints");
  const id = /data-testid="board"[^>]*\bid="([^"]+)"|\bid="([^"]+)"[^>]*data-testid="board"/.exec(html);
  const boardId = id?.[1] ?? id?.[2];
  assert.ok(boardId, "board has an id");
  for (const [dir, label] of [["left", t.scrollLeft], ["right", t.scrollRight]] as const) {
    const btn = new RegExp(`<button[^>]*data-testid="board-nav-${dir}"[^>]*>`).exec(html)?.[0] ?? "";
    assert.match(btn, /type="button"/, dir);
    assert.ok(btn.includes(`aria-label="${label}"`), `${dir} label`);
    assert.ok(btn.includes(`aria-controls="${boardId}"`), `${dir} controls the board`);
    assert.equal(/\bdisabled=""/.test(btn), dir === "left", `${dir} disabled state at the leftmost position`);
  }
});

test("board layout: capped height and two-way scroll from sm up, natural height on phones, sticky header + Symbol column", () => {
  const html = board(assetsBySymbol(loaded(ctx())));
  const boardTag = /<div[^>]*data-testid="board"[^>]*>/.exec(html)?.[0] ?? "";
  for (const c of ["overflow-x-auto", "sm:max-h-[75vh]", "sm:overflow-y-auto", "board-scroll"]) assert.ok(boardTag.includes(c), c);
  assert.doesNotMatch(boardTag, /(^|\s|")max-h-|(^|\s|")overflow-y-auto/, "no vertical cap or nested vertical scroll on phones");
  assert.match(html, /<thead class="[^"]*sm:sticky sm:top-0 sm:z-20/);
  // the top-left corner: the Symbol header cell is pinned left and opaque
  assert.match(html, /<th scope="col" class="[^"]*sticky left-0 z-10 bg-background/);
  // all 15 columns are still there
  const thead = /<thead[\s\S]*?<\/thead>/.exec(html)?.[0] ?? "";
  assert.equal((thead.match(/<th /g) ?? []).length, 15);
});

test("navigation words exist in both locales; the scrollbar style is defined", async () => {
  for (const l of LOCALES) {
    const t = MESSAGES[l].table;
    for (const k of ["swipe", "scrollHint", "scrollLeft", "scrollRight"] as const) assert.ok(t[k].length > 0, `${l}.${k}`);
  }
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  assert.match(css, /\.board-scroll::-webkit-scrollbar \{/);
  assert.match(css, /scrollbar-width: thin/);
});

// ---------- C6-L2: English is the first-visit language ----------
test("first visit without a saved choice renders in English; both locales stay selectable", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  const html = renderToStaticMarkup(createElement(DemoApp));
  assert.match(html, /<div lang="en"/);
  assert.ok(text(html).includes(en.hero.subtitle));
  assert.ok(text(html).includes(en.demo.bannerTitle));
  // the switcher still offers both languages, current one pressed
  for (const l of LOCALES) assert.match(html, new RegExp(`data-testid="lang-${l}"`), l);
  assert.match(html, /<button[^>]*lang="en"[^>]*aria-pressed="true"|<button[^>]*aria-pressed="true"[^>]*lang="en"/);
});
