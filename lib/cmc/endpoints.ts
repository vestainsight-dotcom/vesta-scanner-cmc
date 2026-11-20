// CoinMarketCap Pro API: the only endpoints this project may call, and their
// documented credit costs. [CMC Hackathon — new integration]
//
// Credit rules as documented in the CMC Pro API reference (checked 2026-11-19;
// C2 confirms each one against `status.credit_count` of a real response):
//   /v1/cryptocurrency/map            0 credits
//   /v3/cryptocurrency/quotes/latest  1 per 250 cryptocurrencies returned (rounded up), +1 per extra convert
//   /v1/global-metrics/quotes/latest  1 per call, +1 per extra convert
//   /v3/fear-and-greed/latest         1 per request
//   /v1/key/info                      0 credits (usage self-check)

export const CMC_BASE_URL = "https://pro-api.coinmarketcap.com";
export const CMC_HOST = "pro-api.coinmarketcap.com";
/** Request header that carries the API key. The key itself is never logged or returned. */
export const CMC_KEY_HEADER = "X-CMC_PRO_API_KEY";

export const ENDPOINTS = {
  map: "/v1/cryptocurrency/map",
  quotes: "/v3/cryptocurrency/quotes/latest",
  global: "/v1/global-metrics/quotes/latest",
  fearGreed: "/v3/fear-and-greed/latest",
  keyInfo: "/v1/key/info",
} as const;
export type EndpointName = keyof typeof ENDPOINTS;
export const ENDPOINT_PATHS: readonly string[] = Object.values(ENDPOINTS);

/** Only USD is ever requested, so no extra-convert credits apply. */
export const CONVERT = "USD";
/** Upper bound on ids per quotes request (the scanner shows at most 60 rows). */
export const MAX_IDS_PER_QUOTES_REQUEST = 100;

/** Expected credit cost of one call, from the documented rules above. */
export function expectedCredits(endpoint: EndpointName, returnedCount = 0): number {
  switch (endpoint) {
    case "map":
    case "keyInfo":
      return 0;
    case "quotes":
      return Math.max(1, Math.ceil(returnedCount / 250));
    case "global":
    case "fearGreed":
      return 1;
  }
}
