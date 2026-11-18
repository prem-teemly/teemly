# Teemly Opportunity Room

A private CRM built from call recordings. The owner uploads a call (Tamil, English or Tanglish), and the
app produces:

- the transcript, with speakers and an English translation;
- the people in the call;
- the deals that were discussed, with their department;
- the promises made and when they are due;
- each person's interest.

Nothing is added to People without the owner's approval.

```
frontend/   Next.js 16 + React 19 + TypeScript     port 3000 (the only port users reach, behind HTTPS)
backend/    Node.js 20+ + Express 5 + MySQL 8       port 8000 (127.0.0.1 only; the frontend forwards /api to it)
```

AI runs on Google Gemini through Vertex AI (`gemini-3.8-flash`). It authenticates with Google
Application Default Credentials, so the project has no API keys.

## Features

| Page | What it does |
|---|---|
| **Upload** | Upload a call recording (wav, mp3, m4a, ogg, opus, mp4 and more; up to 100 MB). The same recording uploaded twice is refused. |
| **Today** | Top opportunities, follow-ups (late ones in red), AI insights (at-risk deals first), stage movement, pipeline by department. |
| **Inbox** | New people found in calls wait here. The AI pre-fills their department and category, and the owner adds them with a phone number. A same-name person is shown with their department and the last 4 digits of their phone. |
| **People / Person** | Each person's calls timeline, deals, commitments (late ones in red, paged), the people they introduced, and their interest: Very interested / Interested / Slightly interested / Not interested / Not clear yet. |
| **Opportunity panel** | Board and list of deals across 7 stages, moved by drag and drop. A per-deal AI insight shows the AI's chance vs the stage's, and what would help. |
| **Departments** | Pipeline and people per department; the owner can add departments. |
| **Network map, Notifications, PDF export, Settings** | |

Sign-in is by email with a one-time code, for the owner only.

## Server setup (production)

### 1. Requirements

- Node.js 20 or newer, MySQL 8, and nginx (or another HTTPS reverse proxy).
- A Google Cloud service account with **Vertex AI User** (`roles/aiplatform.user`) on the project, with
  `aiplatform.googleapis.com` enabled. Attach it to the server, or set `GOOGLE_APPLICATION_CREDENTIALS`
  to its key file. The key file is never committed.
- Microsoft Edge or Google Chrome, for PDF export (optional; `EXPORT_BROWSER_PATH` if not on the default path).
- Speaker-detection models in `backend/models/` (about 45 MB, not in Git). Download them from the official
  sherpa-onnx releases, or copy the folder from the development machine:

  ```bash
  cd backend && mkdir -p models && cd models
  wget https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  tar xjf sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 && rm sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  wget https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
  ```

  Expected layout: `models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx` and
  `models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`.

### 2. Database

Create the database and its two least-privilege users from `backend/db/setup/create_users.template.sql`
(details in `backend/db/README.md`). Then:

```bash
cd backend
npm ci
cp .env.example .env       # fill it in (see below); never commit it
npm run db:migrate         # creates / updates all tables (22 migrations)
```

### 3. Configuration (`backend/.env`)

Every setting is documented in `backend/.env.example`. The ones that matter in production:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production`: Secure cookie, API docs off, HSTS, and login codes never printed |
| `OWNER_EMAIL`, `OWNER_NAME` | the owner's sign-in email and name. **The backend refuses to start in production without `OWNER_EMAIL`.** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | email for the sign-in codes (Gmail: an App Password) |
| `DB_*`, `DB_MIGRATION_*` | the MySQL users from step 2 |
| `AUDIT_HASH_KEY` | a long random string (32+ characters), new for this server |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | the Vertex AI project |
| `FRONTEND_ORIGINS` | the public URL, e.g. `https://room.example.com` |
| `APP_TIMEZONE` | `Asia/Kolkata` |

Frontend: `frontend/.env` holds `BACKEND_URL=http://127.0.0.1:8000` (see `frontend/.env.example`).

Secrets (`SMTP_PASS`, DB passwords, `AUDIT_HASH_KEY`) are shared outside Git, never in the repository.

### 4. Build and run

```bash
cd backend  && NODE_ENV=production npm start                 # one process only: no PM2 cluster mode
cd frontend && npm ci && npm run build && npm run start -- -p 3000 -H 127.0.0.1
```

Run each as a service (systemd or PM2 in fork mode). Run **exactly one backend process**, because
running analyses and sign-in codes are kept in memory.

### 5. nginx (HTTPS in front of the frontend)

```nginx
server {
    listen 443 ssl;
    server_name room.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 101m;          # call recordings up to 100 MB
    proxy_read_timeout   300s;          # AI insight and PDF export can take a while

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Do not expose ports 3000 or 8000 to the internet. Without `X-Forwarded-For`, every visitor looks
like one client to the rate limits.

### 6. Check

- `curl http://127.0.0.1:8000/health` returns `{"status":"success"}`.
- The backend log shows `MySQL connected`, `Login: ON`, and the speaker models found.
- Open the site, sign in with the owner email, upload a short call, and check that it appears in Inbox.

## Security and data

- **Login:** every `/api` route needs a session, except `/health` and `/api/auth/*`.
  - Codes expire in 5 minutes and allow 5 tries; resends are limited.
  - Sessions are an httpOnly, SameSite=Lax cookie (Secure in production).
- **Code:** all SQL is parameterized.
- **Uploads:** checked for size, type, file signature and real audio content (ffprobe), and stored under random names.
- **Headers and limits:** security headers and CSP on the API and the pages, rate limits on uploads, AI and sign-in, and a CORS allow-list.
- **Git:** never in the repository (all git-ignored):
  - `.env` files;
  - `backend/uploads/` (recordings);
  - `backend/backups/` (database dumps, personal data);
  - `backend/models/`.
- **Logs:** never contain conversation content.

## Development

```powershell
cd backend;  npm install; copy .env.example .env; npm run db:migrate; npm run dev   # http://127.0.0.1:8000
cd frontend; npm install; npm run dev                                                # http://127.0.0.1:3000
```

Tests (backend): `npm test` runs the offline tests; `npm run test:db` runs the MySQL tests on
`teemly_db_test`. Frontend checks: `npx tsc --noEmit` and `npx eslint .`. More detail is in
`backend/README.md` and `backend/db/README.md`.
