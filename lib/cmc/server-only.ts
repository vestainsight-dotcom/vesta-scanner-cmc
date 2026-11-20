// Runtime guard for server-only CMC modules. [CMC Hackathon — new integration]
//
// The CMC client and key handling must never run in a browser. Next.js only
// bundles a module for the client if a client component imports it; the
// security scan forbids that import (rule `client-imports-cmc`), and this
// guard fails closed if it ever happens anyway.

export class ServerOnlyError extends Error {
  constructor() {
    super("CMC modules are server-only");
    this.name = "ServerOnlyError";
  }
}

export function assertServerRuntime(): void {
  if (typeof window !== "undefined" || typeof document !== "undefined") throw new ServerOnlyError();
}
