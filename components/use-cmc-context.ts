"use client";

// Loads GET /api/cmc/context in the browser after hydration, then every
// CMC_POLL_MS while the page is visible. [CMC Hackathon — C4]
// The server HTML always renders the "loading" state, so server and first
// browser render agree. Failures keep the last good context (its own
// stale / as_of labels still describe it), except an unavailable answer,
// which replaces it.

import { useEffect, useState } from "react";
import { CMC_POLL_MS, loadCmcContext, type CmcLoad } from "@/lib/data/cmc-context-client";

export function useCmcContext(): CmcLoad {
  const [load, setLoad] = useState<CmcLoad>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const next = await loadCmcContext();
      if (!alive) return;
      // a network blip keeps showing the last validated context
      setLoad((prev) => (next.kind === "error" && next.error === "NETWORK" && prev.kind === "loaded" ? prev : next));
    };
    const first = setTimeout(() => void run(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void run();
    }, CMC_POLL_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  return load;
}
