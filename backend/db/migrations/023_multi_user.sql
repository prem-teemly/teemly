-- Accounts: every user has their own room.
--
-- Until now one room was shared by whoever could sign in. Now anyone with an account signs up and signs
-- in with their email (one-time code), and sees only their own calls, transcripts, people, inbox,
-- opportunities, departments, notifications and settings.
--
-- How rows are owned: every table a user's data starts from gets user_id (users.id). Tables below them
-- are reached only through their parent and are owned through it:
--   processing_jobs  -> transcripts, speakers, segments, translations, summaries, decisions,
--                       action_items, follow_ups, emotion_analysis, pulse_insights, person_mentions
--   opportunities    -> opportunity_stage_changes, opportunity_insights
-- Uniques that were global become per user (a phone number, a department name, a notification key).
--
-- Existing data is kept. If the database already holds a room (calls, people, own departments or
-- settings), it goes to the first account; when there is no account yet, an account without an email
-- is created to hold it, and the first sign-in with OWNER_EMAIL takes that account over (see
-- auth/store.js). A database with no room yet (a fresh install) keeps nothing global: each new account
-- gets its own departments when it is created.
--
-- Sign-up needs no new table: the code table keeps only a keyed hash of the email, and the email and
-- the new account's name are sent again with the code (auth/index.js).

-- 1) The column, empty for now.
ALTER TABLE audio_files            ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE audio_uploads          ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Who uploaded (users.id)' AFTER id;
ALTER TABLE processing_jobs        ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE exports                ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Who exported (users.id)' AFTER id;
ALTER TABLE audit_logs             ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Who did it (users.id); NULL = the system' AFTER id;
ALTER TABLE people                 ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE person_suggestions     ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE person_notes           ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE opportunities          ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE departments            ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE department_suggestions ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Owner (users.id)' AFTER id;
ALTER TABLE notifications          ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Who it is for (users.id)' AFTER id;
ALTER TABLE notification_facts     ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Whose fact (users.id)' FIRST;
ALTER TABLE app_settings           ADD COLUMN user_id BIGINT UNSIGNED NULL COMMENT 'Whose setting (users.id)' FIRST;

-- 2) The account that holds an existing room. Only when there is a room and no account at all.
INSERT INTO users (email, display_name, role, status)
SELECT NULL, 'Owner', 'owner', 'active' FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM users)
   AND (EXISTS (SELECT 1 FROM audio_files)
     OR EXISTS (SELECT 1 FROM people)
     OR EXISTS (SELECT 1 FROM departments WHERE built_in = 0 OR goal_label IS NOT NULL OR target_inr IS NOT NULL OR view_type IS NOT NULL)
     OR EXISTS (SELECT 1 FROM app_settings)
     OR EXISTS (SELECT 1 FROM notifications WHERE dedupe_key <> 'installed'));

-- 3) Existing rows go to the first account (the owner of the room so far).
UPDATE audio_files            SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE audio_uploads          SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE processing_jobs        SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE exports                SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE people                 SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE person_suggestions     SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE person_notes           SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE opportunities          SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE departments            SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE department_suggestions SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE notifications          SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE notification_facts     SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;
UPDATE app_settings           SET user_id = (SELECT MIN(id) FROM users) WHERE user_id IS NULL;

-- 4) A fresh install has no account: its global seed rows (the built-in departments, the
-- "notifications are on" row) are removed; every new account gets its own.
DELETE FROM notification_facts     WHERE user_id IS NULL;
DELETE FROM notifications          WHERE user_id IS NULL;
DELETE FROM app_settings           WHERE user_id IS NULL;
DELETE FROM department_suggestions WHERE user_id IS NULL;
DELETE FROM departments            WHERE user_id IS NULL;
DELETE FROM audio_uploads          WHERE user_id IS NULL;

-- 5) Required from now on, with a foreign key to the account and per-user indexes and uniques.
ALTER TABLE audio_files
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  ADD KEY ix_audio_files_user_sha (user_id, sha256),
  ADD CONSTRAINT fk_audio_files_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE audio_uploads
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Who uploaded (users.id)',
  ADD KEY ix_audio_uploads_user (user_id, created_at),
  ADD CONSTRAINT fk_audio_uploads_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE processing_jobs
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  ADD KEY ix_processing_jobs_user (user_id, status, created_at),
  ADD CONSTRAINT fk_processing_jobs_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE exports
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Who exported (users.id)',
  ADD KEY ix_exports_user (user_id),
  ADD CONSTRAINT fk_exports_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE audit_logs
  ADD KEY ix_audit_logs_user (user_id, created_at),
  ADD CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE people
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  DROP INDEX uq_people_phone,
  ADD UNIQUE KEY uq_people_user_phone (user_id, phone),
  ADD KEY ix_people_user_contact (user_id, last_contact_at),
  ADD KEY ix_people_user_name (user_id, name_key),
  ADD CONSTRAINT fk_people_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE person_suggestions
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  ADD KEY ix_person_suggestions_user (user_id, status, created_at),
  ADD CONSTRAINT fk_person_suggestions_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE person_notes
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  ADD KEY ix_person_notes_user (user_id),
  ADD CONSTRAINT fk_person_notes_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE opportunities
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  ADD KEY ix_opportunities_user_stage (user_id, stage, due_date),
  ADD CONSTRAINT fk_opportunities_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE departments
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  DROP INDEX uq_departments_slug,
  DROP INDEX uq_departments_name,
  ADD UNIQUE KEY uq_departments_user_slug (user_id, slug),
  ADD UNIQUE KEY uq_departments_user_name (user_id, name),
  ADD CONSTRAINT fk_departments_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE department_suggestions
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Owner (users.id)',
  ADD KEY ix_department_suggestions_user (user_id, status, created_at),
  ADD CONSTRAINT fk_department_suggestions_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE notifications
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Who it is for (users.id)',
  DROP INDEX uq_notifications_dedupe,
  ADD UNIQUE KEY uq_notifications_user_dedupe (user_id, dedupe_key),
  ADD KEY ix_notifications_user_latest (user_id, updated_at),
  ADD KEY ix_notifications_user_group (user_id, group_key),
  ADD CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE notification_facts
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Whose fact (users.id)',
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (user_id, fact_key),
  ADD CONSTRAINT fk_notification_facts_user FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE app_settings
  MODIFY user_id BIGINT UNSIGNED NOT NULL COMMENT 'Whose setting (users.id)',
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (user_id, name),
  ADD CONSTRAINT fk_app_settings_user FOREIGN KEY (user_id) REFERENCES users (id);
