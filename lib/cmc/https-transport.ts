// Server-only HTTPS transport for the CMC client. [CMC Hackathon — new integration, C2]
//
// The only file in the project allowed to make a network request (besides the
// demo service worker); the security scan enforces this.
//
//   - https only, only to the CMC Pro API host, no userinfo, no custom port
//   - GET only, redirects refused (a redirect could carry the key elsewhere)
//   - no caching by the HTTP layer; caching is lib/cmc/cache.ts's job
//   - response body streamed with a hard byte cap
//   - one attempt; no retries (the cache decides when to try again)
//   - the request signal (client timeout) is honoured
//
// Headers are passed through from the client and never logged.

import { MAX_RESPONSE_BYTES, ResponseTooLargeError, type Transport } from "@/lib/cmc/client";
import { CMC_HOST } from "@/lib/cmc/endpoints";
import { assertServerRuntime } from "@/lib/cmc/server-only";

export class TransportRefusedError extends Error {
  constructor() {
    super("request refused: not an allowed CMC URL");
    this.name = "TransportRefusedError";
  }
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/** True only for https://<CMC host>/... with no credentials or port. */
export function isAllowedCmcUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === CMC_HOST && u.port === "" && u.username === "" && u.password === "";
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export function createHttpsTransport(opts: { maxBytes?: number; fetchImpl?: FetchLike } = {}): Transport {
  assertServerRuntime();
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return async (req) => {
    if (!isAllowedCmcUrl(req.url)) throw new TransportRefusedError();
    const res = await doFetch(new URL(req.url), {
      method: "GET",
      headers: req.headers,
      signal: req.signal,
      redirect: "error",
      cache: "no-store",
    });
    const body = await readCapped(res, maxBytes);
    return {
      status: res.status,
      header: (name) => res.headers.get(name),
      headerNames: () => [...res.headers.keys()].sort(),
      text: async () => body,
    };
  };
}
