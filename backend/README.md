# Meeting Audio Analysis — Backend (Node.js + Express)

Express 5.3 API for upload, background jobs, speaker diarization (local, sherpa-onnx) and the Google
Gemini integration on Vertex AI (transcription, translation, summaries, Pulse).
Authentication uses Application Default Credentials only; no API keys are read or stored.

## Project structure

```
backend/
├── src/
│   ├── server.js              # Entry point (HOST:PORT, default 127.0.0.1:8000)
│   ├── app.js                 # Express app, CORS, API docs, error responses
│   ├── routes.js              # All API endpoints
│   ├── http.js                # JSON responses, validation errors, CORS, uploads
│   ├── config.js              # Settings from .env / environment
│   ├── util.js                # Logging, rounding, bounded concurrency
│   └── services/
│       ├── gemini.js          # Shared Vertex AI client (ADC), IAM-aware errors, JSON helper
│       ├── audio.js           # FFmpeg decoding to 16 kHz mono, WAV encoding
│       ├── transcription.js   # Gemini transcription (chunked, parallel) + translation
│       ├── diarization.js     # Worker-thread pool + speaker labelling
│       ├── diarizationWorker.js
│       ├── analysis.js        # Meeting / chat summary schema and Gemini call
│       ├── pulse.js           # Teemly Pulse: evidence-backed interest / intent signals
│       └── pipeline.js        # Background jobs + progress
├── tests/
│   ├── offline.test.js        # No-network tests (Gemini faked): npm test
│   └── live-check.js          # Real Gemini check: npm run live-check -- [recording]
├── docs/                      # OpenAPI description and /docs, /redoc pages
├── models/                    # Diarization models (download separately if needed)
├── uploads/                   # Uploaded audio (git-ignored)
├── .env.example
└── package.json
```

## Installation and run

Requires Node.js 20 or newer.

```powershell
npm install
copy .env.example .env        # first time only
gcloud auth application-default login   # first time only (Google Cloud ADC)
npm start                     # http://127.0.0.1:8000, API docs at /docs
```

`npm run dev` restarts on file changes. `npm test` runs the offline tests.

## Database (MySQL)

Uploads, jobs and all results are stored in MySQL `teemly_db` (least-privilege user `teemly_app`),
so finished analyses survive a backend restart. Schema, ER diagram, setup and commands:
[db/README.md](db/README.md). Without `DB_USER` in `.env` the API keeps working in memory only.

```powershell
npm run db:migrate   # create / update tables
npm run db:status    # applied migrations
npm run test:db      # MySQL tests (teemly_db_test)
```

## Audio storage (local or OCI Object Storage)

`STORAGE_PROVIDER=local` (default) keeps original recordings in `backend/uploads/` only, as before.
With `STORAGE_PROVIDER=oci`, every upload is also stored in a **private** OCI Object Storage bucket
through the official OCI SDK (`oci-objectstorage`), backend-only:

- Flow: upload → saved and SHA-256-verified locally → ffprobe → uploaded to OCI with Content-MD5 and
  `If-None-Match: *` (never overwrites) → verified by HEAD (size + SHA-256) → MySQL
  `audio_files.storage_provider = 'oci'`, `storage_path = oci://<namespace>/<bucket>/audio/<yyyy>/<mm>/<file>`.
- The local file stays as a working copy. If it is missing when an analysis starts, it is downloaded
  from OCI and SHA-256-verified first.
- If OCI is unreachable at upload, the recording is kept locally (recorded as `local`) and can be
  moved later with the migration. Temporary errors (network, 408, 429, 5xx, damaged transfer) are
  retried with backoff; access errors are not.
- Authentication: `OCI_AUTH=api_key` (key **file path** in `OCI_PRIVATE_KEY_PATH`), `config_file`, or
  `instance_principal`. See `.env.example`. Nothing about OCI is sent to the frontend.
- Needs migration 002 (storage columns) to record the location in MySQL.

```powershell
npm run storage:check                                  # namespace, bucket, private access
npm run storage:migrate -- --dry-run                   # what would move; changes nothing
npm run storage:migrate -- --batch 20 [--limit 100]    # teemly_db_test only
npm run storage:migrate -- --batch 20 --confirm-production   # only with explicit approval
```

The migration checks each file's SHA-256 against MySQL, uploads and verifies, then updates MySQL;
it resumes safely, never deletes local files, and writes a report to `backend/storage-reports/`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/audio/upload` | Upload a recording (wav, mp3, m4a, flac, aac, amr, 3gp, ogg, opus, mp4, webm; ≤100 MB) |
| POST | `/api/analysis` | Start the full job: transcribe → translate → speakers → summary + Pulse |
| GET | `/api/analysis/{job_id}` | Poll job progress / result |
| POST | `/api/audio/transcribe` | Synchronous transcription + translation (short files) |
| GET | `/api/whatsapp/{job_id}` | A chat analysed before chat upload was removed (read only) |
| POST | `/api/ai/translate` | `{text}` → professional English |
| POST | `/api/ai/summarize` | `{text, kind: "meeting"|"chat"}` → structured summary |
| GET | `/api/ai/status` | Check ADC, project and access to both models |
| GET | `/health` | Liveness |
| GET | `/api/db/status` | MySQL connection and migration status |
| POST | `/api/export/pdf` | `{job_id, title}` → Teemly PDF report |
| GET | `/docs`, `/redoc`, `/openapi.json` | API documentation |

## Configuration (`.env`)

See `.env.example` for every setting and its default. Key ones:

| Variable | Default | Notes |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | — | `project-7c7a86a2-b174-4f5d-8c5` |
| `GOOGLE_CLOUD_LOCATION` | `global` | |
| `GEMINI_TRANSCRIBE_MODEL` / `GEMINI_TEXT_MODEL` | `gemini-3.8-flash` | `gemini-2.5-flash` was retired on 2026-10-20 |
| `PORT` | `8000` | The frontend calls `http://127.0.0.1:8000` by default |
| `JOB_CONCURRENCY` | `3` | Jobs processed at the same time |
| `DIARIZATION_THRESHOLD` | `0.75` | Lower = more speakers. Calibrated: 0.5 over-split, 0.8 merged speakers |

## Notes

- Languages tested end to end: Tamil, English, Tanglish, Hindi, Telugu. Each is transcribed in its own
  script with English words kept in Latin script, then translated into professional English.
- Speakers: Gemini's per-chunk turn-taking is mapped onto local diarization's whole-recording voice
  identities (`diarization.assignSpeakers`). Diarization runs in worker threads so the API stays
  responsive.
- Timestamps come from Gemini in whole seconds and can be off by about 1-2 s.
- Running jobs are in memory; finished jobs are reloaded from MySQL after a restart (a job that was running when the backend stopped is reported as failed).
