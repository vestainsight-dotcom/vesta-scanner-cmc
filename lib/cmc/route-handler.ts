// HTTP response for GET /api/cmc/context. [CMC Hackathon — new integration, C3; gate C6-D]
//
// Kept separate from the Next.js route file so it can be tested without Next.
//
// The route is the dashboard's own data feed, not a public CMC data API:
//   - Only same-origin browser requests are answered. Browsers attach
//     `Sec-Fetch-Site` to every request, and page scripts cannot set or change
//     it (a forbidden header name), so another website cannot use this route
//     from its visitors' browsers — not with fetch, <script>, <img> or an
//     iframe, and not with a request it builds itself. Requests without the
//     header (non-browser clients) or with any other value are refused with
//     403 BEFORE the CMC service runs, so they never spend credits.
//   - Every response is `private, no-store`: no shared (CDN) copy exists that
//     could be served to a request that did not pass this check.
//   This is a limited browser-request restriction, NOT authentication and not a
//   guaranteed anti-redistribution control: a non-browser client can send the
//   header itself and receive what a visitor sees (as it could scrape the page).
//
// The body of an answered request is ALWAYS a schema-valid vesta.cmc.context.v1:
//   ok / partial  -> 200
//   unavailable   -> 503 (with a valid "unavailable" body, so clients degrade)
//   anything thrown, or a body that fails validation -> 503 unavailable
// The only part of the request ever read is the Sec-Fetch-Site header value.

import { unavailableContext } from "@/lib/cmc/context";
import { cmcContextSchema, type CmcContext } from "@/lib/schema/cmc-context-v1";

export const RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

/** true only for a same-origin request from a browser. */
export function isSameOriginBrowserRequest(secFetchSite: string | null): boolean {
  return secFetchSite === "same-origin";
}

const FORBIDDEN_BODY = JSON.stringify({ error: "forbidden", detail: "same-origin dashboard requests only" });

export async function respond(
  getContext: () => Promise<CmcContext>,
  secFetchSite: string | null,
  now: () => number = Date.now,
): Promise<Response> {
  if (!isSameOriginBrowserRequest(secFetchSite)) {
    return new Response(FORBIDDEN_BODY, { status: 403, headers: RESPONSE_HEADERS });
  }
  let ctx: CmcContext;
  try {
    const parsed = cmcContextSchema.safeParse(await getContext());
    ctx = parsed.success ? parsed.data : unavailableContext("BAD_RESPONSE", now());
  } catch {
    ctx = unavailableContext("BAD_RESPONSE", now());
  }
  return new Response(JSON.stringify(ctx), {
    status: ctx.status === "unavailable" ? 503 : 200,
    headers: RESPONSE_HEADERS,
  });
}
