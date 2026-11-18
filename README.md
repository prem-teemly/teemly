# Tamil-English Meeting Audio Analysis (POC)

Upload a meeting or Android/iPhone call recording → transcript in the original language (Tamil,
English, Tanglish, Hindi or Telugu), professional English translation, speaker-wise transcript with
timestamps, meeting summary, key points, decisions, action items and follow-ups. The transcript
appears as soon as it is ready; the summary and Pulse follow.

WhatsApp chat upload was removed: only call recordings are uploaded. Chats analysed before that are
still shown on people's timelines.

AI runs on Google Gemini via Vertex AI (`gemini-3.8-flash` for transcription, translation,
summaries and Pulse), authenticated with Application Default Credentials — no API keys.

**Teemly Pulse** (right-hand panel) shows evidence-backed interest and intent signals — product
interest, purchase intent, preferences, pain points, concerns, competitors, commitments — each with
the speaker, the exact supporting sentence (original + English) and a timestamp that seeks the audio.

```
frontend/   Next.js 16 + React 19 + TypeScript   http://127.0.0.1:3000
backend/    Node.js + Express 5.3                 http://127.0.0.1:8000   (API docs: /docs)
```

## First-time setup

Requires Node.js 20 or newer.

**Backend** (PowerShell, from `backend/`):

```powershell
npm install
copy .env.example .env
```

**Google Cloud authentication** (one time, needs the gcloud CLI:
<https://cloud.google.com/sdk/docs/install>):

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project project-7c7a86a2-b174-4f5d-8c5
```

The signed-in account (or the `gemini-app-backend` service account in deployment, via
`GOOGLE_APPLICATION_CREDENTIALS` or an attached identity) needs **Vertex AI User**
(`roles/aiplatform.user`) on the project, and `aiplatform.googleapis.com` must be enabled.
Verify with `GET http://127.0.0.1:8000/api/ai/status` or `npm run live-check` (in `backend/`).

**Frontend** (from `frontend/`):

```powershell
npm install
```

## Run

Two terminals:

```powershell
# Terminal 1 — backend/
npm start
```

```powershell
# Terminal 2 — frontend/
npm run dev
```

Open <http://127.0.0.1:3000> and click Upload: choose an audio file (wav, mp3, m4a, flac, aac, amr,
3gp, ogg, opus, mp4, webm; up to 100 MB).

For production use `npm run build` then `npm run start -- -p 3000 -H 127.0.0.1` in `frontend/`.
To point the UI at a different backend, set `NEXT_PUBLIC_API_BASE_URL` (see `frontend/.env.example`).

## Security and data protection

- Google credentials stay on the backend (Application Default Credentials, least-privilege
  `roles/aiplatform.user`); no API keys anywhere, `.env` is git-ignored.
- The backend listens on 127.0.0.1 only and accepts browser requests only from the configured
  frontend origins (CORS).
- Uploads are validated (extension, file signature, size); stored names are random, so paths cannot
  be guessed or traversed. Uploaded recordings and chats are kept by default; set
  `UPLOAD_RETENTION_HOURS` to delete them after that many hours (never while a job is using them).
- Security headers on every response; uploads and AI calls are rate limited per client
  (`RATE_LIMIT_PER_MINUTE`); request bodies are size-limited.
- Logs contain no conversation content.
- Phone OTP sign-in (owner only). It is off until `OWNER_PHONE` (and `OWNER_NAME`) are set in
  `backend/.env` and migration 003 is applied (`npm run db:migrate`). When on, every API except
  `/health` and `/api/auth/*` needs a session, and the frontend sends you to `/login`, then to `/people`.
  - The number is never stored: only an HMAC with `AUDIT_HASH_KEY` (32+ random characters, checked at
    startup) and its last 4 digits.
  - Codes are 6 random digits, kept only as HMACs. They expire in 5 minutes and allow 5 tries; resends
    are limited (30 s apart, 5 per hour per number, 10 per hour per client).
  - Unknown numbers get the same answer as the owner's, so the API never shows which numbers are allowed.
  - Sessions use a random token in an httpOnly, SameSite=Lax cookie (7 days, `Secure` in production).
    Only its SHA-256 is stored, and signing out revokes it.
  - `OTP_PROVIDER=console` prints the code in the backend terminal for development, and is refused when
    `NODE_ENV=production`. An SMS provider is needed before going live.
  - The frontend calls `/api/*` on its own origin, and Next.js forwards those calls to `BACKEND_URL`.
    That keeps the cookie first-party; leave `NEXT_PUBLIC_API_BASE_URL` unset.
