// CMC columns for the scanner table (live CoinMarketCap data next to simulated
// rows). [CMC Hackathon — C4] Presentational only. Only contract fields are
// shown; nothing is combined with the row's (simulated) scanner values.

import type { CmcAsset } from "@/lib/schema/cmc-context-v1";
import { formatUsdCompact } from "@/lib/data/cmc-view";
import type { Messages } from "@/lib/i18n/messages";
import { formatPct } from "@/lib/scanner/format";

// a faint green tint marks every live CMC cell, so live and simulated columns never blur
export const CMC_TINT = "bg-[#16a34a]/[0.035]";
const TH = "px-3 py-3 font-mono text-[10px] font-normal tracking-widest whitespace-nowrap text-[#15803d]/80 uppercase";
const TD = `px-3 py-2.5 whitespace-nowrap ${CMC_TINT}`;
const UP = "text-[#15803d]";
const DOWN = "text-[#b91c1c]";
const signColor = (p: number | null) => (p === null || p === 0 ? "text-foreground/60" : p > 0 ? UP : DOWN);

export const CMC_COLUMN_COUNT = 4;

export function CmcHeaderCells({ m }: { m: Messages }) {
  const t = m.cmc.table;
  return (
    <>
      <th scope="col" data-cmc="th" className={`${TH} ${CMC_TINT}`}>{t.rank}</th>
      <th scope="col" data-cmc="th" className={`${TH} ${CMC_TINT} text-right`}>{t.marketCap}</th>
      <th scope="col" data-cmc="th" className={`${TH} ${CMC_TINT} text-right`}>{t.spotVolume}</th>
      <th scope="col" data-cmc="th" className={`${TH} ${CMC_TINT} text-right`}>{t.change}</th>
    </>
  );
}

export function CmcRowCells({ asset, m }: { asset: CmcAsset | undefined; m: Messages }) {
  const t = m.cmc.table;
  if (!asset || asset.state !== "OK") {
    const [label, title] =
      asset?.state === "NO_QUOTE"
        ? [t.noQuote, t.noQuoteTitle]
        : asset?.state === "AMBIGUOUS"
          ? [t.ambiguous, t.ambiguousTitle]
          : [t.unmapped, t.unmappedTitle];
    return (
      <>
        <td data-cmc="none" data-cmc-state={asset?.state ?? "MISSING"} className={TD} title={title}>
          <span className="text-xs text-foreground/45">{label}</span>
        </td>
        <td className={`${TD} text-right text-foreground/35`}>—</td>
        <td className={`${TD} text-right text-foreground/35`}>—</td>
        <td className={`${TD} text-right text-foreground/35`}>—</td>
      </>
    );
  }
  return (
    <>
      <td data-cmc="ok" className={TD} title={asset.multiplier > 1 ? t.multiplier(asset.multiplier) : undefined}>
        <span className="font-medium text-foreground/85">{asset.rank !== null ? `#${asset.rank}` : "—"}</span>
        <div className="mt-0.5">
          <span data-tier={asset.tier} className="rounded-full border border-foreground/15 px-1.5 py-px text-[11px] text-foreground/60">
            {m.cmc.tiers[asset.tier]}
          </span>
        </div>
      </td>
      <td className={`${TD} text-right text-foreground/85`}>{formatUsdCompact(asset.market_cap_usd)}</td>
      <td className={`${TD} text-right text-foreground/85`}>{formatUsdCompact(asset.volume_24h_usd)}</td>
      <td className={`${TD} text-right`}>
        <span className={signColor(asset.change_24h_pct)}>{formatPct(asset.change_24h_pct)}</span>
        <div className={`text-xs ${signColor(asset.change_7d_pct)}`}>{formatPct(asset.change_7d_pct)}</div>
      </td>
    </>
  );
}
