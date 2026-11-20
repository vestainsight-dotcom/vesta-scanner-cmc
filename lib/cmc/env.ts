// The CMC API key: the only secret this project reads from the environment.
// (Besides it, only NEXT_PHASE is read, to disable CMC during `next build`.)
// [CMC Hackathon — new integration]
//
// - Set it in a git-ignored `.env.local` (locally) or the hosting provider's
//   encrypted environment settings. Never in code, tests, docs or the client.
// - The key is wrapped in ApiKey, whose JSON / string / inspect forms are all
//   "[redacted]", so it cannot leak through logging or serialisation by mistake.
// - No key -> CMC context is "unavailable" (reason NO_KEY); the scanner board
//   is unaffected.
//
// The security scan allows `process.env` reads only for this one variable and
// only in this file.

import { assertServerRuntime } from "@/lib/cmc/server-only";

export const CMC_KEY_ENV = "CMC_PRO_API_KEY";
// Conservative shape check; CMC keys are hex-and-dash identifiers.
const KEY_RE = /^[A-Za-z0-9-]{16,64}$/;
const REDACTED = "[redacted]";

export class ApiKey {
  readonly #value: string;
  private constructor(value: string) {
    this.#value = value;
  }
  /** Returns null for anything that is not key-shaped (whitespace is trimmed). */
  static parse(raw: string | undefined | null): ApiKey | null {
    const v = (raw ?? "").trim();
    return KEY_RE.test(v) ? new ApiKey(v) : null;
  }
  /** The raw value, for the request header only. */
  reveal(): string {
    return this.#value;
  }
  toString() {
    return REDACTED;
  }
  toJSON() {
    return REDACTED;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return REDACTED;
  }
}

export type KeyState = { kind: "present"; key: ApiKey } | { kind: "missing" } | { kind: "malformed" } | { kind: "disabled" };

// Set by Next.js while `next build` runs. CMC is never called during a build,
// even if a route were accidentally pre-rendered.
const NEXT_PHASE_ENV = "NEXT_PHASE";
const BUILD_PHASE = "phase-production-build";

/** Reads the key from the server environment. Never logs or returns the raw value. */
export function readCmcKey(env: Readonly<Record<string, string | undefined>> = process.env): KeyState {
  assertServerRuntime();
  if (env[NEXT_PHASE_ENV] === BUILD_PHASE) return { kind: "disabled" };
  const raw = env[CMC_KEY_ENV];
  if (raw === undefined || raw.trim() === "") return { kind: "missing" };
  const key = ApiKey.parse(raw);
  return key ? { kind: "present", key } : { kind: "malformed" };
}
