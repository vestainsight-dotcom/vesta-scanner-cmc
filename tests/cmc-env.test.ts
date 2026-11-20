// API key handling: read from one variable, never revealed by accident. [CMC Hackathon]

import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { ApiKey, CMC_KEY_ENV, readCmcKey } from "@/lib/cmc/env";
import { ServerOnlyError, assertServerRuntime } from "@/lib/cmc/server-only";
import { FAKE_KEY } from "./fixtures/cmc";

test("missing, blank and malformed keys are reported without the value", () => {
  assert.deepEqual(readCmcKey({}), { kind: "missing" });
  assert.deepEqual(readCmcKey({ [CMC_KEY_ENV]: "   " }), { kind: "missing" });
  assert.deepEqual(readCmcKey({ [CMC_KEY_ENV]: "short" }), { kind: "malformed" });
  assert.deepEqual(readCmcKey({ [CMC_KEY_ENV]: `${FAKE_KEY} extra` }), { kind: "malformed" });
  assert.deepEqual(readCmcKey({ [CMC_KEY_ENV]: `${FAKE_KEY};` }), { kind: "malformed" });
});

test("a present key is trimmed and only reveal() returns it", () => {
  const s = readCmcKey({ [CMC_KEY_ENV]: `  ${FAKE_KEY}\n` });
  assert.equal(s.kind, "present");
  if (s.kind !== "present") return;
  assert.equal(s.key.reveal(), FAKE_KEY);
  for (const shown of [String(s.key), `${s.key}`, JSON.stringify(s), JSON.stringify({ k: s.key }), inspect(s), inspect(s.key)]) {
    assert.ok(!shown.includes(FAKE_KEY), shown);
    assert.match(shown, /\[redacted\]/);
  }
  assert.deepEqual(Object.keys(s.key), []);
});

test("only CMC_PRO_API_KEY is read", () => {
  assert.equal(CMC_KEY_ENV, "CMC_PRO_API_KEY");
  assert.deepEqual(readCmcKey({ OTHER_KEY: FAKE_KEY }), { kind: "missing" });
});

test("ApiKey.parse rejects non-strings and odd characters", () => {
  assert.equal(ApiKey.parse(undefined), null);
  assert.equal(ApiKey.parse(null), null);
  assert.equal(ApiKey.parse(FAKE_KEY.replace("0", "%")), null);
  assert.equal(ApiKey.parse("x".repeat(65)), null);
});

test("server-only modules refuse to run where a browser window exists", () => {
  const g = globalThis as { window?: unknown };
  assert.doesNotThrow(() => assertServerRuntime());
  g.window = {};
  try {
    assert.throws(() => assertServerRuntime(), ServerOnlyError);
    assert.throws(() => readCmcKey({}), ServerOnlyError);
  } finally {
    delete g.window;
  }
});
