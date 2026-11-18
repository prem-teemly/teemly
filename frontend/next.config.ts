import type { NextConfig } from "next";

// The backend (Express) is reached through this same origin: the browser calls /api/... and Next.js
// forwards it to the backend. The login session cookie is then first-party (httpOnly, SameSite=Lax)
// and no cross-site cookies or CORS credentials are needed. BACKEND_URL is server-side only.
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

// Security headers on every page (the API sets its own). The app is never framed, never sniffed, sends
// no full referrer to other sites, and asks for no camera / microphone / location. HSTS (HTTPS only,
// a year) is sent in production; browsers ignore it over plain HTTP.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  // Dev server only: the app is opened at http://127.0.0.1:3000 (not "localhost"), so allow that host
  // to load dev resources (hot reload). Without this the page stays on the loading spinner.
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false, // do not advertise "X-Powered-By: Next.js"
  experimental: {
    // /api is forwarded to the backend through this server. Next.js stops forwarding a body at 10 MB and
    // a request at 30 s by default: call recordings may be up to 100 MB (the backend's limit) and an AI
    // insight or a PDF can take longer than 30 s, so the proxy allows a little more than the backend does.
    proxyClientMaxBodySize: "101mb",
    proxyTimeout: 300_000,
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/health", destination: `${BACKEND_URL}/health` },
    ];
  },
};

export default nextConfig;
