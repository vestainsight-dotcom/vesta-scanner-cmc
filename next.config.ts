import type { NextConfig } from "next";

// Demo PWA lives under /demo with its own service worker (/demo-sw.js) and its
// own cache names, so it can never touch another VESTA app's PWA on the same origin.
// Page security headers (L-5). Everything is same-origin: the browser only talks
// to this app (CMC is called by the server route). 'unsafe-inline' scripts are
// needed for Next.js's inline hydration data on the statically rendered /demo
// page (a nonce would force dynamic rendering); 'unsafe-eval' only in `next dev`.
const dev = process.env.NODE_ENV === "development";
export const PAGE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: PAGE_CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The demo uses no optimized images. Disabling Image Optimization keeps the
  // /_next/image endpoint (and the native image library behind it) out of use
  // when the demo is served with `next start`.
  images: { unoptimized: true },
  async headers() {
    return [
      // every path first; the more specific rules below override per key
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // always revalidated so updates reach installed apps
        source: "/demo-sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
      {
        source: "/demo/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/demo/offline.html",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/", destination: "/demo", permanent: false },
      // clients that request /favicon.ico directly get the existing app icon
      { source: "/favicon.ico", destination: "/demo/icons/icon-192.png", permanent: false },
    ];
  },
};

export default nextConfig;
