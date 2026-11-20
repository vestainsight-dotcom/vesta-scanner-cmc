// Server-only CoinMarketCap Pro API client. [CMC Hackathon — new integration]
//
// - Talks only to the CMC Pro API host and paths listed in endpoints.ts.
// - The HTTP transport is injected: lib/cmc/https-transport.ts in production,
//   test doubles in unit tests. This file itself makes no network calls.
// - Every response is size-capped, parsed with a schema and checked for CMC's
//   status.error_code. Failures become a CmcError carrying a reason code (and a
//   backoff hint for the cache); upstream messages and the key are never
//   included in errors.

import { z } from "zod";
import {
  CMC_BASE_URL,
  CMC_HOST,
  CMC_KEY_HEADER,
  CONVERT,
  ENDPOINT_PATHS,
  ENDPOINTS,
  MAX_IDS_PER_QUOTES_REQUEST,
  type EndpointName,
} from "@/lib/cmc/endpoints";
import {
  errorResponseSchema,
  fearGreedResponseSchema,
  globalResponseSchema,
  keyInfoResponseSchema,
  mapResponseSchema,
  quoteItems,
  quotesResponseSchema,
  type CmcKeyInfo,
  type CmcMapItem,
  type CmcQuoteItem,
  type CmcStatus,
} from "@/lib/cmc/raw";
import type { ApiKey } from "@/lib/cmc/env";
import { assertServerRuntime } from "@/lib/cmc/server-only";
import type { Reason } from "@/lib/schema/cmc-context-v1";

export interface TransportRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  header(name: string): string | null;
  /** Response header names (diagnostics only; never values). */
  headerNames?(): string[];
  text(): Promise<string>;
}
/** One HTTP GET. Implementations must honour `signal`. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export const DEFAULT_TIMEOUT_MS = 8_000;
export const MAX_RESPONSE_BYTES = 2_000_000;

/** Thrown by a transport that stopped reading a body over MAX_RESPONSE_BYTES. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super("response too large");
    this.name = "ResponseTooLargeError";
  }
}
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class CmcError extends Error {
  readonly reason: Reason;
  readonly endpoint: EndpointName;
  readonly httpStatus: number | null;
  readonly cmcErrorCode: number | null;
  /** Read by the cache to delay the next attempt. */
  readonly backoffMs: number;
  constructor(
    reason: Reason,
    endpoint: EndpointName,
    opts: { httpStatus?: number | null; cmcErrorCode?: number | null; backoffMs?: number } = {},
  ) {
    super(`CMC ${endpoint}: ${reason}`);
    this.name = "CmcError";
    this.reason = reason;
    this.endpoint = endpoint;
    this.httpStatus = opts.httpStatus ?? null;
    this.cmcErrorCode = opts.cmcErrorCode ?? null;
    this.backoffMs = opts.backoffMs ?? 0;
  }
}

export interface CmcResult<T> {
  data: T;
  credits: number | null; // status.credit_count as reported by CMC
}

const toCode = (c: CmcStatus["error_code"]) => (c === null || c === undefined ? 0 : Number(c));

/** Backoff for a CMC error code; 1008 = minute, 1009 = daily, 1010 = monthly limit (per the CMC reference). */
function rateLimitBackoff(code: number, retryAfter: string | null): number {
  if (code === 1010) return 6 * HOUR;
  if (code === 1009) return HOUR;
  const s = retryAfter !== null && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
  return Math.min(Math.max(s, MINUTE), HOUR);
}

const SYMBOL_PARAM_RE = /^[A-Z0-9]{1,32}$/;

export interface CmcClientOptions {
  apiKey: ApiKey;
  transport: Transport;
  timeoutMs?: number;
}

export class CmcClient {
  private readonly apiKey: ApiKey;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private credits = 0;

  constructor(opts: CmcClientOptions) {
    assertServerRuntime();
    this.apiKey = opts.apiKey;
    this.transport = opts.transport;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Credits reported by CMC across this client's successful calls. */
  get creditsUsed(): number {
    return this.credits;
  }

  /** Active CMC listings for these symbols (0 credits). */
  async map(symbols: readonly string[]): Promise<CmcResult<CmcMapItem[]>> {
    const list = [...new Set(symbols)].sort();
    if (list.length === 0) return { data: [], credits: 0 };
    if (list.length > 500 || !list.every((s) => SYMBOL_PARAM_RE.test(s))) throw new CmcError("BAD_RESPONSE", "map");
    const r = await this.call("map", { listing_status: "active", symbol: list.join(",") }, mapResponseSchema);
    return { data: r.body.data, credits: r.credits };
  }

  /** USD quotes by CMC ID. */
  async quotes(ids: readonly number[]): Promise<CmcResult<CmcQuoteItem[]>> {
    const list = [...new Set(ids)].sort((a, b) => a - b);
    if (list.length === 0) return { data: [], credits: 0 };
    if (list.length > MAX_IDS_PER_QUOTES_REQUEST || !list.every((n) => Number.isInteger(n) && n > 0)) {
      throw new CmcError("BAD_RESPONSE", "quotes");
    }
    const r = await this.call("quotes", { id: list.join(","), convert: CONVERT, skip_invalid: "true" }, quotesResponseSchema);
    return { data: quoteItems(r.body.data), credits: r.credits };
  }

  async global(): Promise<CmcResult<z.infer<typeof globalResponseSchema>["data"]>> {
    const r = await this.call("global", { convert: CONVERT }, globalResponseSchema);
    return { data: r.body.data, credits: r.credits };
  }

  async fearGreed(): Promise<CmcResult<z.infer<typeof fearGreedResponseSchema>["data"]>> {
    const r = await this.call("fearGreed", {}, fearGreedResponseSchema);
    return { data: r.body.data, credits: r.credits };
  }

  /** Plan limits and credit usage of this key (documented 0 credits). Manual smoke tests only; never used by the route. */
  async keyInfo(): Promise<CmcResult<CmcKeyInfo>> {
    const r = await this.call("keyInfo", {}, keyInfoResponseSchema);
    return { data: r.body.data, credits: r.credits };
  }

  /** Builds the request URL; refuses anything but the CMC host and the allowed paths. */
  static buildUrl(endpoint: EndpointName, params: Readonly<Record<string, string>>): string {
    const path = ENDPOINTS[endpoint];
    const url = new URL(path, CMC_BASE_URL);
    if (url.protocol !== "https:" || url.host !== CMC_HOST || !ENDPOINT_PATHS.includes(url.pathname)) {
      throw new CmcError("BAD_RESPONSE", endpoint);
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async call<S extends z.ZodType<{ status: CmcStatus }>>(
    endpoint: EndpointName,
    params: Readonly<Record<string, string>>,
    schema: S,
  ): Promise<{ body: z.infer<S>; credits: number | null }> {
    const url = CmcClient.buildUrl(endpoint, params);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CmcError("TIMEOUT", endpoint, { backoffMs: MINUTE }));
      }, this.timeoutMs);
    });

    let res: TransportResponse;
    let raw: string;
    try {
      res = await Promise.race([
        this.transport({
          url,
          headers: { [CMC_KEY_HEADER]: this.apiKey.reveal(), Accept: "application/json" },
          signal: controller.signal,
        }),
        timeout,
      ]);
      raw = await Promise.race([res.text(), timeout]);
    } catch (e) {
      if (e instanceof CmcError) throw e;
      if (e instanceof ResponseTooLargeError) throw new CmcError("BAD_RESPONSE", endpoint);
      throw new CmcError("NETWORK", endpoint, { backoffMs: MINUTE });
    } finally {
      clearTimeout(timer);
    }

    if (raw.length > MAX_RESPONSE_BYTES) throw new CmcError("BAD_RESPONSE", endpoint, { httpStatus: res.status });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }

    if (res.status !== 200) {
      const status = errorResponseSchema.safeParse(json);
      const code = status.success ? toCode(status.data.status.error_code) : 0;
      throw this.httpError(endpoint, res.status, code, res.header("retry-after"));
    }

    // CMC can report an error inside a 200; check status before the data shape
    const head = errorResponseSchema.safeParse(json);
    const code = head.success ? toCode(head.data.status.error_code) : 0;
    if (code !== 0) throw this.httpError(endpoint, 200, code, null);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CmcError("BAD_RESPONSE", endpoint, { httpStatus: 200 });
    const body = parsed.data as z.infer<S>;

    const credits = body.status.credit_count ?? null;
    if (credits !== null) this.credits += credits;
    return { body, credits };
  }

  private httpError(endpoint: EndpointName, http: number, code: number, retryAfter: string | null): CmcError {
    // CMC error codes (Pro API reference; C2 confirms): 1001-1002 key invalid/missing,
    // 1003-1007 plan/payment/permission, 1008-1011 rate limits.
    const o = { httpStatus: http, cmcErrorCode: code || null };
    if (http === 429 || (code >= 1008 && code <= 1011)) {
      return new CmcError("RATE_LIMITED", endpoint, { ...o, backoffMs: rateLimitBackoff(code, retryAfter) });
    }
    if (http === 401 || code === 1001 || code === 1002) return new CmcError("UNAUTHORIZED", endpoint, { ...o, backoffMs: HOUR });
    if (http === 402 || http === 403 || (code >= 1003 && code <= 1007)) {
      return new CmcError("PLAN_FORBIDDEN", endpoint, { ...o, backoffMs: HOUR });
    }
    return new CmcError("UPSTREAM_ERROR", endpoint, { ...o, backoffMs: 2 * MINUTE });
  }
}
