// Entry point: `npm start` (or `node src/server.js`). Listens on HOST:PORT (default 127.0.0.1:8000).

import * as config from "./config.js";
import { createApp } from "./app.js";
import { startRetention } from "./security.js";
import * as db from "./db/pool.js";
import * as storage from "./storage/index.js";
import { assertProviderAllowed } from "./auth/otp.js";
import { assertStrongHashKey } from "./auth/phone.js";
import * as authStore from "./auth/store.js";
import * as repo from "./db/repository.js";

const fail = (message) => {
  process.stderr.write(`ERROR:    ${message}\n`);
  process.exit(1);
};

// NODE_ENV=test lets the tests run requests as a fixed user without signing in (config.testUser): a
// real server must never start that way.
if (process.env.NODE_ENV === "test") fail("NODE_ENV=test is only for the automated tests. Use NODE_ENV=production on a server (or leave it unset on this computer).");

// Every user has their own room, kept in MySQL: without it nobody could sign in.
if (!db.isConfigured()) fail("Accounts need the database. Set DB_USER / DB_PASSWORD (and run npm run db:migrate) in backend/.env, then start again.");

// Sign-in: refuse to start with an unsafe setup (e.g. codes printed in the terminal in production).
try {
  assertProviderAllowed(config.AUTH.otpProvider);
  assertStrongHashKey();
} catch (exc) {
  fail(exc.message);
}

startRetention(); // only deletes uploads if UPLOAD_RETENTION_HOURS is set (off by default)

// Housekeeping, hourly: old sign-in codes and sessions that ended long ago.
const housekeeping = () => authStore.purgeOld().catch((e) => process.stderr.write(`WARNING:  housekeeping failed: ${e?.message ?? e}\n`));
setInterval(housekeeping, 3600_000).unref();

const server = createApp().listen(config.PORT, config.HOST, () => {
  process.stdout.write(`INFO:     API running on http://${config.HOST}:${config.PORT} (Press CTRL+C to quit)\n`);
  process.stdout.write(`INFO:     Time zone: ${config.APP_TIMEZONE} (now ${new Date().toString().slice(16, 24)}) · API docs: ${config.API_DOCS ? "on (/docs)" : "off"}${config.TRUSTED_PROXIES.length ? ` · trusted proxies: ${config.TRUSTED_PROXIES.join(", ")}` : ""}\n`);
  // Uploads that were being analysed when the server stopped cannot continue: mark them failed.
  repo.failInterruptedJobs().then((n) => n && process.stdout.write(`INFO:     ${n} upload(s) interrupted by the last restart marked failed\n`));
  void housekeeping();
  // Report whether MySQL persistence is on (the API works either way).
  db.status().then((st) => {
    const line = st.connected
      ? `MySQL connected: ${st.database} on ${st.host}:${st.port} as ${st.user} (MySQL ${st.server_version}, ${st.migrations.length} migration(s) applied)`
      : `MySQL persistence is OFF: ${st.error}`;
    process.stdout.write(`INFO:     ${line}\n`);
    process.stdout.write(`INFO:     ${storage.describe()}\n`);
    const signup = config.AUTH.signupEnabled ? (config.AUTH.signupAllowed.length ? `sign-up for ${config.AUTH.signupAllowed.length} allowed email(s)/domain(s)` : "anyone can sign up") : "sign-up closed";
    const codes = config.AUTH.otpProvider === "smtp" ? `emailed via ${config.SMTP.host}` : "printed here (console, no email: set SMTP_PASS to email them)";
    process.stdout.write(`INFO:     Login: ON, one room per account (${signup}; codes ${codes})\n`);
    if (st.connected && !st.migrations.some((m) => m.version === 23)) process.stdout.write("WARNING:  Accounts need migration 023: run npm run db:migrate, then restart.\n");
    // On a public server NODE_ENV must be production (Secure cookie, API docs off, HSTS).
    if (process.env.NODE_ENV !== "production") process.stdout.write("WARNING:  NODE_ENV is not 'production': fine on this computer; on a hosted server set NODE_ENV=production.\n");
  });
});
server.on("error", (err) => {
  // e.g. EADDRINUSE: fail loudly with a non-zero exit code instead of exiting quietly.
  process.stderr.write(`ERROR:    could not start the API on ${config.HOST}:${config.PORT}: ${err.message}\n`);
  process.exit(1);
});
server.requestTimeout = 0; // long uploads are allowed, as before
server.headersTimeout = 60_000;
server.keepAliveTimeout = 5_000; // same keep-alive window as before

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    db.closePool().finally(() => process.exit(0));
  });
}
