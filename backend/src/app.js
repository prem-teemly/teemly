// Express application: CORS, routes, API docs, and error responses in the API's JSON shape.

import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";

import * as config from "./config.js";
import { accessLog, cors, errorHandler, notFound } from "./http.js";
import { ROUTES, router } from "./routes.js";
import { requireAuth } from "./auth/index.js";
import { rateLimit, securityHeaders } from "./security.js";
import { getLogger } from "./util.js";

const logger = getLogger("app.main");
const DOCS_DIR = path.join(config.BACKEND_DIR, "docs");
const page = (file) => readFileSync(path.join(DOCS_DIR, file), "utf8");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("query parser", "simple");

  app.use(accessLog);
  app.use(securityHeaders);
  app.use(cors);
  app.use(rateLimit());
  app.use(requireAuth); // only when login is enabled (OWNER_PHONE set)
  app.use(router);

  // Interactive API docs: development only (API_DOCS), so production does not describe its API to
  // anyone who asks (they are reachable without signing in).
  const docs = config.API_DOCS
    ? [
        ["/openapi.json", "application/json", page("openapi.json")],
        ["/docs", "text/html; charset=utf-8", page("docs.html")],
        ["/redoc", "text/html; charset=utf-8", page("redoc.html")],
      ]
    : [];
  for (const [p, type, body] of docs) {
    const data = Buffer.from(body, "utf8");
    app.get(p, (req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Length", String(data.length));
      res.end(data);
    });
    ROUTES.push({ method: "GET", pattern: new RegExp(`^${p.replace(".", "\\.")}$`) });
  }

  app.use(notFound(ROUTES));
  app.use(errorHandler(logger));
  return app;
}
