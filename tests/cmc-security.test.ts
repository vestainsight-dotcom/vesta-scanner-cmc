// Security-scan rules for the CMC integration. Planted values are synthetic and
// assembled from fragments, only written to temp directories. [CMC Hackathon]

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { j } from "./fixtures/cmc";

const SCRIPT = new URL("../scripts/security-scan.mjs", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const scan = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, "--no-local", "--root", dir, ...args], { encoding: "utf-8" });
const rulesIn = (stderr: string) => new Set([...stderr.matchAll(/\[([a-z0-9:@/.-]+)\]/g)].map((m) => m[1].split(":")[0]));

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cmc-scan-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, dependencies: { next: "1" } }));
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    if (parts.length > 1) mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...parts), content);
  }
  return dir;
}
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
function gitProject(files: Record<string, string>) {
  const dir = project({ ".gitignore": ".env.*\n/security.local.json\n", ...files });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", j("dev", "@users.noreply", ".github.com"));
  return dir;
}

const HOST = j("pro-api", ".coinmarket", "cap.com");
const KEY_VAR = j("CMC_PRO", "_API_KEY");
const ENV = j("process", ".env");
const UUID = j("0a1b2c3d", "-", "4e5f", "-", "6a7b", "-", "8c9d", "-", "0e1f2a3b4c5d");

test("the CMC integration as committed passes its own rules", () => {
  const r = scan(ROOT, "--no-local");
  const rules = rulesIn(r.stderr);
  for (const rule of ["env-read", "cmc-api-key", "cmc-host-outside-endpoints", "cmc-import-outside-server", "network-call"]) {
    assert.ok(!rules.has(rule), `${rule}: ${r.stderr}`);
  }
});

test("key-shaped values and literal key assignments are rejected", () => {
  const dir = project({
    "lib/a.ts": `export const k = "${UUID}";`,
    "lib/b.ts": `const h = { "${j("X-", KEY_VAR)}": "${j("abcd", "efgh", "1234")}" };`,
    "docs/c.md": `${KEY_VAR}=${j("abcd", "efgh", "1234")}`,
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.equal((r.stderr.match(/\[cmc-api-key\]/g) ?? []).length, 3, r.stderr);
  assert.ok(!r.stderr.includes(UUID)); // findings never echo the value

  // nil/max UUID constants (shipped by validation libraries) are not keys
  const nil = project({ ".next/static/chunks/z.js": `/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}|${"f".repeat(8)}-ffff-ffff-ffff-${"f".repeat(12)}/` });
  assert.ok(!rulesIn(scan(nil, "--build").stderr).has("bundle-cmc-api-key"), scan(nil, "--build").stderr);
});

test("environment reads: only the key variable, only in lib/cmc/env.ts", () => {
  const ok = project({ "lib/cmc/env.ts": `export const read = (e = ${ENV}) => e["${KEY_VAR}"]; const x = ${ENV}.${KEY_VAR};` });
  assert.equal(scan(ok).status, 0, scan(ok).stderr);

  const other = project({ "lib/cmc/env.ts": `const s = ${ENV}.${j("SUPA", "BASE_URL")};` });
  assert.ok(rulesIn(scan(other).stderr).has("env-read"));

  for (const code of [`const k = ${ENV}.${KEY_VAR};`, `const k = ${ENV}["${KEY_VAR}"];`, `const all = ${ENV};`]) {
    const dir = project({ "lib/cmc/client.ts": code });
    assert.ok(rulesIn(scan(dir).stderr).has("env-read"), code);
  }
  const nodeEnv = project({ "lib/x.ts": `const d = ${ENV}.NODE_ENV === "development";` });
  assert.equal(scan(nodeEnv).status, 0);
});

test("the CMC API host may appear only in the endpoint table", () => {
  const ok = project({ "lib/cmc/endpoints.ts": `export const H = "https://${HOST}";` });
  assert.equal(scan(ok).status, 0, scan(ok).stderr);
  const bad = project({ "components/x.tsx": `const u = "https://${HOST}/v1/x";` });
  assert.ok(rulesIn(scan(bad).stderr).has("cmc-host-outside-endpoints"));
});

test("server-only CMC modules cannot be imported by client code", () => {
  const imp = (spec: string) => `import { CmcClient } from "${spec}";`;
  const allowed = project({
    "lib/cmc/context.ts": imp("@/lib/cmc/client"),
    "app/api/cmc/context/route.ts": imp("@/lib/cmc/client"),
    "tests/x.test.ts": imp("@/lib/cmc/client"),
    "components/board.tsx": `import { tierOf } from "@/lib/schema/cmc-context-v1";`, // the public contract is fine
  });
  assert.equal(scan(allowed).status, 0, scan(allowed).stderr);

  for (const [file, code] of [
    ["components/board.tsx", imp("@/lib/cmc/client")],
    ["app/demo/page.tsx", imp("../../lib/cmc/env")],
    ["lib/data/http.ts", `const m = await import("@/lib/cmc/client");`],
    ["app/api/cmc/context/route.ts", `"use client";\n${imp("@/lib/cmc/client")}`],
    ["lib/cmc/widget.tsx", `'use client';\n${imp("@/lib/cmc/client")}`],
  ]) {
    const dir = project({ [file]: code });
    assert.ok(rulesIn(scan(dir).stderr).has("cmc-import-outside-server"), file);
  }
});

test(".env.local is tolerated only when git-ignored, untracked and chmod 600", () => {
  const content = `${KEY_VAR}=${j("abcd", "efgh", "1234")}`;

  const noGit = project({ ".env.local": content });
  chmodSync(join(noGit, ".env.local"), 0o600);
  const r0 = scan(noGit);
  assert.ok(rulesIn(r0.stderr).has("env-local-outside-git"), r0.stderr);
  assert.ok(!rulesIn(r0.stderr).has("cmc-api-key")); // contents are never read

  const good = gitProject({ ".env.local": content });
  chmodSync(join(good, ".env.local"), 0o600);
  assert.equal(scan(good).status, 0, scan(good).stderr);

  chmodSync(join(good, ".env.local"), 0o644);
  assert.ok(rulesIn(scan(good).stderr).has("env-local-permissions"));

  const notIgnored = gitProject({ ".gitignore": "/security.local.json\n", ".env.local": content });
  chmodSync(join(notIgnored, ".env.local"), 0o600);
  assert.ok(rulesIn(scan(notIgnored).stderr).has("env-local-not-ignored"));

  const tracked = gitProject({ ".env.local": content });
  chmodSync(join(tracked, ".env.local"), 0o600);
  git(tracked, "add", "-f", ".env.local");
  assert.ok(rulesIn(scan(tracked).stderr).has("env-local-tracked"));

  // every other env file is still forbidden outright
  for (const name of [".env", ".env.production", ".env.development.local"]) {
    const dir = gitProject({ [name]: "X=1" });
    assert.ok(rulesIn(scan(dir).stderr).has("forbidden-file"), name);
  }
});

test("the client bundle must not contain the CMC host, key variable or a key", () => {
  for (const planted of [`fetch("https://${HOST}/v3/x")`, `h["${KEY_VAR}"]`, `k="${UUID}"`]) {
    const dir = project({ ".next/static/chunks/a.js": planted });
    const rules = rulesIn(scan(dir, "--build").stderr);
    assert.ok(rules.has("bundle-cmc-server-code") || rules.has("bundle-cmc-api-key"), planted);
  }
});

test("only the HTTPS transport in lib/cmc makes network calls, and it checks the CMC host", () => {
  const dir = join(ROOT, "lib", "cmc");
  for (const f of readdirSync(dir)) {
    if (!statSync(join(dir, f)).isFile()) continue;
    const src = readFileSync(join(dir, f), "utf-8");
    if (f === "https-transport.ts") {
      assert.match(src, /globalThis\.fetch\(/);
      assert.match(src, /isAllowedCmcUrl\(req\.url\)/);
      assert.match(src, /redirect: "error"/);
      continue;
    }
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|node:https?|undici/, f);
  }
});

test("network calls are still rejected anywhere except the allowed files", () => {
  const dir = project({ "lib/cmc/client.ts": `await fetch(u);`, "scripts/cmc-smoke.ts": `await fetch(u);` });
  const r = scan(dir);
  assert.equal((r.stderr.match(/\[network-call\]/g) ?? []).length, 2, r.stderr);
});
