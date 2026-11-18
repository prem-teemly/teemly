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

// Login moved from phone to email: a backend/.env that still only names an owner phone would start
// with login OFF (an open room), so refuse and say what to set instead.
if (!config.authEnabled() && config.AUTH.legacyOwnerPhones.length) {
  process.stderr.write("ERROR:    Sign-in is by email now. Set OWNER_EMAIL in backend/.env (the owner's email), then start again.\n");
  process.exit(1);
}

// Production never runs as an open room: without OWNER_EMAIL every person, recording and export would be
// readable by anyone who can reach the server. Fail closed instead of starting with login off.
if (process.env.NODE_ENV === "production" && !config.authEnabled()) {
  process.stderr.write("ERROR:    NODE_ENV=production but login is OFF. Set OWNER_EMAIL (and SMTP_* to email the codes) in backend/.env, then start again.\n");
  process.exit(1);
}

// Login: refuse to start with an unsafe setup (e.g. codes printed in the terminal in production).
if (config.authEnabled()) {
  assertProviderAllowed(config.AUTH.otpProvider);
  assertStrongHashKey();
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
    const login = config.authEnabled()
      ? `Login: ON (${config.AUTH.ownerEmails.length} owner email(s), codes ${config.AUTH.otpProvider === "smtp" ? `emailed via ${config.SMTP.host}` : "printed here (console, no email: set SMTP_PASS to email them)"})`
      : "Login: OFF (set OWNER_EMAIL in .env to require sign-in)";
    process.stdout.write(`INFO:     ${login}\n`);
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
