// Market context from CoinMarketCap (live), shown above the simulated scanner.
// [CMC Hackathon — C4] Presentational only: data and words come in as props.

import type { ReactNode } from "react";
import type { CmcLoad } from "@/lib/data/cmc-context-client";
import { cmcBadges, fearGreedClass, formatPp, formatShare, formatUsdCompact, usableContext, type CmcBadge } from "@/lib/data/cmc-view";
import type { Messages } from "@/lib/i18n/messages";
import { formatDateTime } from "@/lib/scanner/format";
import { ATTRIBUTION } from "@/lib/schema/cmc-context-v1";

const BADGE_TONE: Record<CmcBadge, string> = {
  LOADING: "border-foreground/20 text-foreground/55",
  LIVE: "border-[#16a34a]/45 bg-[#16a34a]/[0.07] text-[#15803d]",
  STALE: "border-[#d97706]/50 bg-[#d97706]/[0.07] text-[#b45309]",
  PARTIAL: "border-[#d97706]/50 bg-[#d97706]/[0.07] text-[#b45309]",
  UNAVAILABLE: "border-foreground/30 bg-foreground/[0.05] text-foreground/70",
};

export function SourceTag({ tone, children, testId }: { tone: "sim" | "live"; children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-widest whitespace-nowrap uppercase ${
        tone === "sim"
          ? "border-accent-tech/50 bg-accent-tech/[0.07] text-accent-tech"
          : "border-[#16a34a]/45 bg-[#16a34a]/[0.07] text-[#15803d]"
      }`}
    >
      {children}
    </span>
  );
}

function Stat({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-foreground/10 bg-background px-3 py-2.5">
      <span className="font-mono text-[10px] tracking-widest text-foreground/50 uppercase">{label}</span>
      <span className="text-lg font-medium text-foreground tabular-nums">{value}</span>
      {sub && <span className="text-xs text-foreground/55 tabular-nums">{sub}</span>}
    </div>
  );
}

export function CmcContextPanel({ load, m }: { load: CmcLoad; m: Messages }) {
  const c = m.cmc;
  const badges = cmcBadges(load);
  const ctx = usableContext(load);
  const b = ctx?.backdrop ?? null;
  const fg = b?.fear_greed ?? null;
  const fgClass = fg ? fearGreedClass(fg.classification) : null;
  const na = <span className="text-sm font-normal text-foreground/45">{c.stats.notAvailable}</span>;

  // why the section is partial or unavailable (codes only, from the contract)
  let note: string | null = null;
  if (load.kind === "error") note = c.clientErrors[load.error];
  else if (load.kind === "loaded" && load.ctx.reason) note = c.reasons[load.ctx.reason] ?? null;

  return (
    <section
      data-testid="cmc-panel"
      data-state={badges.join(" ")}
      aria-labelledby="cmc-panel-title"
      className="mt-10 flex min-w-0 flex-col gap-3 rounded-xl border border-foreground/15 bg-foreground/[0.02] px-4 py-4 sm:px-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="cmc-panel-title" className="text-base font-medium text-foreground">
            {c.sectionTitle}
          </h2>
          <p className="text-xs text-foreground/55">{c.sectionSub}</p>
          <CmcAttribution testId="cmc-attribution" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="cmc-badges">
          {badges.map((x) => (
            <span
              key={x}
              data-badge={x}
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-widest whitespace-nowrap uppercase ${BADGE_TONE[x]}`}
            >
              {c.badges[x]}
            </span>
          ))}
        </div>
      </div>

      {ctx && (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Stat
              testId="cmc-market-cap"
              label={c.stats.marketCap}
              value={b?.total_market_cap_usd != null ? formatUsdCompact(b.total_market_cap_usd) : na}
              sub={b?.total_volume_24h_usd != null ? c.stats.totalVolume(formatUsdCompact(b.total_volume_24h_usd)) : undefined}
            />
            <Stat
              testId="cmc-btc-dominance"
              label={c.stats.btcDominance}
              value={b?.btc_dominance_pct != null ? formatShare(b.btc_dominance_pct) : na}
              sub={
                b?.btc_dominance_change_24h_pct != null ? c.stats.dominanceChange(formatPp(b.btc_dominance_change_24h_pct)) : undefined
              }
            />
            <Stat
              testId="cmc-fear-greed"
              label={c.stats.fearGreed}
              value={fg ? fg.value : na}
              sub={fg ? (fgClass ? c.fearGreedClasses[fgClass] : fg.classification) : undefined}
            />
          </div>
          {/* the one CMC timestamp: the original as_of (fetch time of the market values) */}
          {ctx.as_of && (
            <p data-testid="cmc-as-of-label" className="font-mono text-[11px] tracking-wide text-foreground/55">
              {c.asOf(formatDateTime(ctx.as_of))}
            </p>
          )}
        </>
      )}

      {(note || ctx?.stale || !ctx) && load.kind !== "loading" && (
        <div data-testid="cmc-note" className="flex flex-col gap-0.5 text-xs text-foreground/65">
          {note && <span>{note}</span>}
          {ctx?.stale && <span>{c.staleNote}</span>}
          {!ctx && <span>{c.scannerUnaffected}</span>}
        </div>
      )}

    </section>
  );
}

/** Required CoinMarketCap attribution, exact wording and link; shown wherever CMC data is shown. */
export function CmcAttribution({ testId }: { testId: string }) {
  return (
    <p data-testid={testId} className="text-xs font-medium text-foreground/75">
      <a
        href={ATTRIBUTION.url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-foreground/40 underline-offset-2 transition-colors hover:text-accent-tech"
      >
        {ATTRIBUTION.text}
      </a>
    </p>
  );
}
