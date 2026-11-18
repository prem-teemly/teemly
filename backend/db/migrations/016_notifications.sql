-- Notifications (the bell): facts from the room, made by the backend, read by the owner.
--
-- notifications: one row per thing worth knowing (a call analysed or failed, a new opportunity from a
-- call, a stage the AI moved, people or a department waiting in the inbox, a next step due today or
-- overdue, a deal gone quiet or stalled, the day-end digest). dedupe_key makes each one happen once
-- (e.g. "due:<opportunity>:<date>"), so making them again is always safe.
--
-- The first row ("installed") marks when notifications were switched on: only things that happen
-- after it are announced, so the bell does not fill with old history.
--
-- app_settings: small owner settings kept in the database (here: which notifications to make and the
-- hour of the day-end digest).

CREATE TABLE notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind        VARCHAR(30)     NOT NULL COMMENT 'analysis | failed | opportunity | stage | inbox | due | overdue | quiet | digest | system',
  title       VARCHAR(200)    NOT NULL,
  body        VARCHAR(600)    NULL,
  link        VARCHAR(300)    NULL COMMENT 'In-app path it opens, e.g. /opportunities/<id>',
  dedupe_key  VARCHAR(160)    NOT NULL,
  read_at     DATETIME(3)     NULL,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notifications_dedupe (dedupe_key),
  KEY ix_notifications_created (created_at),
  KEY ix_notifications_unread (read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO notifications (kind, title, body, link, dedupe_key, read_at, created_at)
VALUES ('system', 'Notifications are on', NULL, NULL, 'installed', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));

CREATE TABLE app_settings (
  name        VARCHAR(60)     NOT NULL,
  value       JSON            NOT NULL,
  updated_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
