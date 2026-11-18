-- Notifications, grouped (best practice: one row per thing, not one per fact):
--   * one row per call: "Call analysed" with the new people, opportunities and moves it brought inside;
--   * one row per deal for repeated updates (stage moves, thank-yous, due / overdue, nudges): the row is
--     updated, counted ("3 updates") and comes back to the top as unread;
--   * many of one kind at once (e.g. 8 overdue) become one row ("8 deals overdue") with the list inside.
-- notification_facts remembers every fact already announced (even when merged into another row), so
-- nothing is announced twice. Existing notifications are kept as they are.

ALTER TABLE notifications
  ADD COLUMN group_key VARCHAR(160) NULL COMMENT 'call:<job> | deal:<opportunity>:<what> | bulk:<kind>:<day>' AFTER dedupe_key,
  ADD COLUMN item_count INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Updates merged into this row' AFTER group_key,
  ADD COLUMN items JSON NULL COMMENT 'What is inside: [{kind, text, sub, link, action, at}]' AFTER item_count,
  ADD COLUMN avatar_name VARCHAR(80) NULL COMMENT 'Whose initials to show (the person it is about)' AFTER link,
  ADD COLUMN updated_at DATETIME(3) NULL COMMENT 'Latest update (rows are sorted by it)' AFTER created_at,
  ADD KEY ix_notifications_group (group_key),
  ADD KEY ix_notifications_latest (updated_at);

UPDATE notifications SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE notification_facts (
  fact_key         VARCHAR(160)    NOT NULL COMMENT 'e.g. opp:<id>:new, move:<id>, inbox:<job>:people',
  notification_id  BIGINT UNSIGNED NULL COMMENT 'The row it was announced in (NULL once that row is cleaned up)',
  created_at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (fact_key),
  KEY ix_notification_facts_notification (notification_id),
  CONSTRAINT fk_notification_facts_notification FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO notification_facts (fact_key, notification_id, created_at) SELECT dedupe_key, id, created_at FROM notifications;
