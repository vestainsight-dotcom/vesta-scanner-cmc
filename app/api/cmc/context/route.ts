// GET /api/cmc/context — live CoinMarketCap context for the demo universe.
// [CMC Hackathon — new integration, C3]
//
// Server-only. Takes no parameters: the only part of the request read is the
// Sec-Fetch-Site header (same-origin browser requests only; see route-handler.ts),
// so visitors cannot choose symbols, ids or endpoints. Only GET is exported
// (Next answers other methods with 405). See lib/cmc/service.ts for caching.

import { respond } from "@/lib/cmc/route-handler";
import { getCmcContext } from "@/lib/cmc/service";

// never pre-rendered at build time (that would call CMC during `next build`)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return respond(getCmcContext, request.headers.get("sec-fetch-site"));
}
