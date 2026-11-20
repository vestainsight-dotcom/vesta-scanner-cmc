// Lets `node --test` (Node >= 22.18 strips TypeScript types natively) load the
// app's TypeScript modules, which import each other without file extensions
// and with the "@/" alias, as Next.js does. No extra dependencies.
//
//   node --import ./tests/register.mjs --test tests/*.test.ts

import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import ts from "typescript";

const ROOT = pathToFileURL(resolvePath(import.meta.dirname, "..") + "/").href;

// Node strips TypeScript types but cannot compile JSX. React components (.tsx)
// are transpiled here with the project's own TypeScript (no extra dependency),
// so tests can render them with react-dom/server. Test-only.
const TSX_OPTIONS = {
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  verbatimModuleSyntax: false,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) specifier = new URL(specifier.slice(2), ROOT).href;
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith(".") || specifier.startsWith("file:");
      if (err?.code !== "ERR_MODULE_NOT_FOUND" || !relative || /\.[cm]?[jt]sx?$/.test(specifier)) throw err;
      // extensionless imports: .ts first, then .tsx (components)
      const base = new URL(specifier, context.parentURL ?? ROOT);
      for (const ext of [".ts", ".tsx"]) {
        if (existsSync(fileURLToPath(`${base.href}${ext}`))) return nextResolve(`${specifier}${ext}`, context);
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf-8");
    const out = ts.transpileModule(source, { compilerOptions: TSX_OPTIONS, fileName: fileURLToPath(url) });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
