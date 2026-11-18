-- Teemly audio metadata (technical details measured with ffprobe at upload).
--
-- Additive and backward compatible: only new columns are added to audio_files, all nullable except
-- storage_provider (which has a default), so existing rows and existing code keep working. Fields
-- that already exist are reused:
--   original filename  -> original_name      stored filename -> stored_name
--   file extension     -> file_format        file size       -> size_bytes
--   upload timestamp   -> created_at         duration        -> duration_seconds
--   SHA-256            -> sha256             upload status   -> audio_uploads.status
--   processing status / job id -> processing_jobs.status / processing_jobs.id
-- The audio itself stays in local storage (backend/uploads); it is never stored in MySQL.

ALTER TABLE audio_files
  ADD COLUMN mime_type        VARCHAR(100)     NULL COMMENT 'Media type derived on the server from the verified content, e.g. audio/mpeg' AFTER file_format,
  ADD COLUMN container_format VARCHAR(100)     NULL COMMENT 'Actual container measured by ffprobe, e.g. mov,mp4,m4a,3gp,3g2,mj2' AFTER mime_type,
  ADD COLUMN audio_codec      VARCHAR(32)      NULL COMMENT 'Codec of the first audio stream (ffprobe), e.g. aac, mp3, pcm_s16le' AFTER container_format,
  ADD COLUMN sample_rate_hz   INT UNSIGNED     NULL COMMENT 'Sample rate of the first audio stream' AFTER audio_codec,
  ADD COLUMN channels         TINYINT UNSIGNED NULL COMMENT 'Channel count of the first audio stream' AFTER sample_rate_hz,
  ADD COLUMN bitrate_bps      INT UNSIGNED     NULL COMMENT 'Overall bitrate in bits per second (ffprobe)' AFTER channels,
  ADD COLUMN storage_provider VARCHAR(16)      NOT NULL DEFAULT 'local' COMMENT 'Where the original file is stored' AFTER duration_seconds,
  ADD COLUMN storage_path     VARCHAR(255)     NULL COMMENT 'Path relative to the backend folder, e.g. uploads/<stored_name>' AFTER storage_provider,
  ADD COLUMN metadata_status  ENUM('extracted','unavailable','failed') NULL COMMENT 'Result of the ffprobe measurement; NULL = not measured (older rows)' AFTER storage_path,
  ADD COLUMN metadata_error   VARCHAR(255)     NULL COMMENT 'Why metadata is unavailable (no secrets, no paths)' AFTER metadata_status;
