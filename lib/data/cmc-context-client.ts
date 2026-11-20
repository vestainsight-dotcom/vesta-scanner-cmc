// Browser-side reader of GET /api/cmc/context. [CMC Hackathon — C4]
//
// - Same-origin only: the one path below; the browser never contacts CoinMarketCap.
// - Accepts the 200 (ok / partial) and 503 (unavailable) bodies the route sends.
// - Every body is validated again with the vesta.cmc.context.v1 schema; anything
//   else is reported as INVALID and never rendered.
// - No key, no CMC host, nothing from lib/cmc (server-only) is imported here.

import { cmcContextSchema, type CmcContext } from "@/lib/schema/cmc-context-v1";

export const CMC_CONTEXT_PATH = "/api/cmc/context";
/** The server refreshes CMC data at most every 15 min; polling faster gains nothing. */
export const CMC_POLL_MS = 5 * 60_000;
export const CMC_FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 200_000;

export type CmcLoad =
  | { kind: "loading" }
  | { kind: "loaded"; ctx: CmcContext }
  | { kind: "error"; error: "NETWORK" | "INVALID" };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function loadCmcContext(
  fetchImpl: FetchLike = (i, init) => globalThis.fetch(i, init),
  timeoutMs = CMC_FETCH_TIMEOUT_MS,
): Promise<Exclude<CmcLoad, { kind: "loading" }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(CMC_CONTEXT_PATH, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    text = await res.text();
  } catch {
    return { kind: "error", error: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
  if ((res.status !== 200 && res.status !== 503) || text.length > MAX_BODY_CHARS) return { kind: "error", error: "INVALID" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "error", error: "INVALID" };
  }
  const parsed = cmcContextSchema.safeParse(json);
  return parsed.success ? { kind: "loaded", ctx: parsed.data } : { kind: "error", error: "INVALID" };
}
