-- 001_initial_schema.sql — Teemly Audio AI schema (MySQL 8.0, InnoDB, utf8mb4).
--
-- One processing job per uploaded file. A job's results are normalised into: transcript → speakers,
-- transcript_segments → translations; summary → decisions, action_items, follow_ups; emotion_analysis;
-- pulse_insights; exports. WhatsApp chats use the same transcript tables (sender = speaker, message
-- time = occurred_at). No user accounts: the application has no login (see README).
-- No conversation content is ever written to audit_logs.

-- Stored files (one row per file on disk in backend/uploads).
CREATE TABLE audio_files (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stored_name       VARCHAR(64)     NOT NULL COMMENT 'Random name in backend/uploads, e.g. <32 hex>.wav',
  original_name     VARCHAR(255)    NOT NULL,
  kind              ENUM('audio','whatsapp') NOT NULL,
  file_format       VARCHAR(10)     NOT NULL,
  size_bytes        BIGINT UNSIGNED NOT NULL,
  sha256            CHAR(64)        NOT NULL,
  duration_seconds  DECIMAL(10,2)   NULL,
  deleted_at        DATETIME(3)     NULL COMMENT 'Set when the file is removed by the retention policy',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audio_files_stored_name (stored_name),
  KEY ix_audio_files_sha256 (sha256),
  KEY ix_audio_files_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every upload attempt, accepted or rejected (rejected ones have no file).
CREATE TABLE audio_uploads (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  audio_file_id    BIGINT UNSIGNED NULL,
  kind             ENUM('audio','whatsapp') NOT NULL,
  original_name    VARCHAR(255)    NULL,
  size_bytes       BIGINT UNSIGNED NULL,
  status           ENUM('accepted','rejected') NOT NULL,
  http_status      SMALLINT UNSIGNED NOT NULL,
  error_message    VARCHAR(500)    NULL,
  client_hash      CHAR(64)        NULL COMMENT 'SHA-256 of the client address (no raw IPs stored)',
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audio_uploads_file (audio_file_id),
  KEY ix_audio_uploads_created (created_at),
  CONSTRAINT fk_audio_uploads_file FOREIGN KEY (audio_file_id) REFERENCES audio_files (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Analysis jobs (the job_id returned by the API).
CREATE TABLE processing_jobs (
  id                   CHAR(32)        NOT NULL COMMENT 'job_id returned by the API',
  audio_file_id        BIGINT UNSIGNED NOT NULL,
  kind                 ENUM('audio','whatsapp') NOT NULL,
  status               ENUM('queued','processing','completed','failed') NOT NULL DEFAULT 'queued',
  stage                VARCHAR(32)     NOT NULL DEFAULT 'queued',
  progress             DECIMAL(4,3)    NOT NULL DEFAULT 0.000,
  error_message        VARCHAR(1000)   NULL,
  num_speakers         TINYINT UNSIGNED NULL,
  transcription_model  VARCHAR(64)     NULL,
  text_model           VARCHAR(64)     NULL,
  timings              JSON            NULL,
  started_at           DATETIME(3)     NULL,
  finished_at          DATETIME(3)     NULL,
  created_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_processing_jobs_file (audio_file_id),
  KEY ix_processing_jobs_status_created (status, created_at),
  CONSTRAINT fk_processing_jobs_file FOREIGN KEY (audio_file_id) REFERENCES audio_files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One transcript per completed job (audio transcript or WhatsApp conversation).
CREATE TABLE transcripts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id            CHAR(32)        NOT NULL,
  source            ENUM('audio','whatsapp') NOT NULL,
  language          VARCHAR(64)     NULL,
  model             VARCHAR(128)    NULL,
  duration_seconds  DECIMAL(10,2)   NULL,
  segment_count     INT UNSIGNED    NOT NULL DEFAULT 0,
  meta              JSON            NULL COMMENT 'Coverage, speaker identification and chat details as returned by the API',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_transcripts_job (job_id),
  CONSTRAINT fk_transcripts_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Speakers (audio) or senders (WhatsApp) of one transcript.
CREATE TABLE speakers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transcript_id   BIGINT UNSIGNED NOT NULL,
  label           VARCHAR(128)    NOT NULL COMMENT 'Speaker 1, Speaker 2, ... or the WhatsApp sender name',
  total_seconds   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  segment_count   INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_speakers_transcript_label (transcript_id, label),
  CONSTRAINT fk_speakers_transcript FOREIGN KEY (transcript_id) REFERENCES transcripts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Lines of a transcript in the original language (Tamil, English, Tanglish, Hindi, Telugu...).
CREATE TABLE transcript_segments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transcript_id   BIGINT UNSIGNED NOT NULL,
  seq             INT UNSIGNED    NOT NULL COMMENT 'Order in the transcript, from 0',
  speaker_id      BIGINT UNSIGNED NULL,
  start_seconds   DECIMAL(10,2)   NULL COMMENT 'Audio position; NULL for chat messages',
  end_seconds     DECIMAL(10,2)   NULL,
  occurred_at     DATETIME        NULL COMMENT 'Message time for WhatsApp chats',
  message_kind    ENUM('speech','text','media','system') NOT NULL DEFAULT 'speech',
  text            TEXT            NOT NULL,
  emotion         VARCHAR(20)     NULL COMMENT 'Emotion heard in the line (tone of voice and words)',
  warning         VARCHAR(255)    NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_segments_transcript_seq (transcript_id, seq),
  KEY ix_segments_speaker (speaker_id),
  KEY ix_segments_transcript_start (transcript_id, start_seconds),
  KEY ix_segments_emotion (emotion),
  CONSTRAINT fk_segments_transcript FOREIGN KEY (transcript_id) REFERENCES transcripts (id) ON DELETE CASCADE,
  CONSTRAINT fk_segments_speaker FOREIGN KEY (speaker_id) REFERENCES speakers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Translations of transcript segments (professional English today; other languages possible).
CREATE TABLE translations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  segment_id    BIGINT UNSIGNED NOT NULL,
  language      VARCHAR(10)     NOT NULL DEFAULT 'en',
  text          TEXT            NOT NULL,
  warning       VARCHAR(255)    NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_translations_segment_language (segment_id, language),
  CONSTRAINT fk_translations_segment FOREIGN KEY (segment_id) REFERENCES transcript_segments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Meeting / conversation summary of a job (one per job).
CREATE TABLE summaries (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id                  CHAR(32)        NOT NULL,
  available               TINYINT(1)      NOT NULL,
  unavailable_reason      VARCHAR(1000)   NULL,
  model                   VARCHAR(64)     NULL,
  purpose                 TEXT            NULL,
  summary                 TEXT            NULL,
  final_summary           TEXT            NULL,
  key_context             JSON            NULL,
  topics                  JSON            NULL,
  important_points        JSON            NULL,
  problems_discussed      JSON            NULL,
  key_takeaways           JSON            NULL,
  transcript_quality_note TEXT            NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_summaries_job (job_id),
  CONSTRAINT fk_summaries_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE decisions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  summary_id   BIGINT UNSIGNED NOT NULL,
  seq          INT UNSIGNED    NOT NULL,
  decision     TEXT            NOT NULL,
  made_by      VARCHAR(255)    NULL,
  evidence     TEXT            NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_decisions_summary_seq (summary_id, seq),
  CONSTRAINT fk_decisions_summary FOREIGN KEY (summary_id) REFERENCES summaries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE action_items (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  summary_id          BIGINT UNSIGNED NOT NULL,
  seq                 INT UNSIGNED    NOT NULL,
  task                TEXT            NOT NULL,
  responsible_person  VARCHAR(255)    NULL,
  date_text           VARCHAR(255)    NULL COMMENT 'As spoken, e.g. tomorrow',
  time_text           VARCHAR(255)    NULL,
  deadline_text       VARCHAR(255)    NULL,
  speaker_label       VARCHAR(128)    NULL,
  evidence            TEXT            NULL,
  uncertain           TEXT            NULL,
  status              ENUM('open','done') NOT NULL DEFAULT 'open',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_action_items_summary_seq (summary_id, seq),
  KEY ix_action_items_status (status),
  KEY ix_action_items_person (responsible_person),
  CONSTRAINT fk_action_items_summary FOREIGN KEY (summary_id) REFERENCES summaries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE follow_ups (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  summary_id   BIGINT UNSIGNED NOT NULL,
  seq          INT UNSIGNED    NOT NULL,
  text         TEXT            NOT NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_follow_ups_summary_seq (summary_id, seq),
  CONSTRAINT fk_follow_ups_summary FOREIGN KEY (summary_id) REFERENCES summaries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Emotion overview of a job (per-line emotions are on transcript_segments.emotion).
CREATE TABLE emotion_analysis (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id              CHAR(32)        NOT NULL,
  available           TINYINT(1)      NOT NULL,
  unavailable_reason  VARCHAR(1000)   NULL,
  dominant_emotion    VARCHAR(20)     NULL,
  overall             JSON            NULL COMMENT '[{emotion, seconds, share}]',
  by_speaker          JSON            NULL,
  timeline            JSON            NULL COMMENT '[{emotion, speaker, start, end, lines}]',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_emotion_analysis_job (job_id),
  KEY ix_emotion_analysis_dominant (dominant_emotion),
  CONSTRAINT fk_emotion_analysis_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Teemly Pulse: one 'overview' row per job, plus one row per signal and per recommended action.
CREATE TABLE pulse_insights (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id            CHAR(32)        NOT NULL,
  row_type          ENUM('overview','signal','recommendation') NOT NULL,
  seq               INT UNSIGNED    NOT NULL,
  available         TINYINT(1)      NULL COMMENT 'overview row only',
  unavailable_reason VARCHAR(1000)  NULL COMMENT 'overview row only',
  overall_interest  VARCHAR(32)     NULL COMMENT 'overview row only',
  dropped_unsupported INT UNSIGNED  NULL COMMENT 'overview row only',
  model             VARCHAR(64)     NULL COMMENT 'overview row only',
  category          VARCHAR(32)     NULL COMMENT 'signal rows',
  person            VARCHAR(255)    NULL,
  subject           VARCHAR(500)    NULL,
  level             ENUM('high','medium','low') NULL,
  basis             ENUM('explicit','inferred') NULL,
  text              TEXT            NULL COMMENT 'overview text, signal context, or recommended action',
  reason            TEXT            NULL COMMENT 'recommendation rows',
  quote             TEXT            NULL,
  quote_verified    TINYINT(1)      NULL,
  evidence          JSON            NULL COMMENT 'Transcript lines supporting the row (id, speaker, time, original, english)',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pulse_job_type_seq (job_id, row_type, seq),
  KEY ix_pulse_category_level (category, level),
  CONSTRAINT fk_pulse_insights_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- PDF reports downloaded through "Export" (the PDF itself is not stored).
CREATE TABLE exports (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id       CHAR(32)        NOT NULL,
  format       ENUM('pdf')     NOT NULL DEFAULT 'pdf',
  title        VARCHAR(200)    NOT NULL,
  size_bytes   INT UNSIGNED    NOT NULL,
  sha256       CHAR(64)        NOT NULL,
  client_hash  CHAR(64)        NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_exports_job (job_id),
  CONSTRAINT fk_exports_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Security / activity log. Never contains conversation content or raw client addresses.
CREATE TABLE audit_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event        VARCHAR(64)     NOT NULL COMMENT 'e.g. upload.accepted, job.completed, export.created',
  entity_type  VARCHAR(32)     NULL,
  entity_id    VARCHAR(64)     NULL,
  outcome      ENUM('success','failure') NOT NULL DEFAULT 'success',
  client_hash  CHAR(64)        NULL,
  detail       JSON            NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_logs_event_created (event, created_at),
  KEY ix_audit_logs_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
