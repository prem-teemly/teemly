-- New-person inbox: a person found in a call or chat is not added to People on its own.
--
-- After a conversation is analysed, every person talked about who is not in People yet (or whose
-- name matches more than one person) becomes a suggestion here. The owner adds them (a new person, or
-- one of the people with that name) or ignores them. Each suggestion keeps the lines it comes from.
-- A conversation suggests a name once: processing it again does not bring back an ignored suggestion.
--
-- People can now share a name (two different "Suresh"), so the name is no longer unique. A phone
-- number, when known, is unique. A category the owner chose is kept: the AI never changes it.

ALTER TABLE people
  DROP INDEX uq_people_name_key,
  ADD KEY ix_people_name_key (name_key),
  ADD COLUMN category_locked TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = chosen by the owner; conversations never change it' AFTER category,
  ADD COLUMN phone VARCHAR(16) NULL COMMENT 'Digits with country code, e.g. +919876543210' AFTER city,
  ADD UNIQUE KEY uq_people_phone (phone);

CREATE TABLE person_suggestions (
  id                  CHAR(32)        NOT NULL COMMENT 'Random public id',
  job_id              CHAR(32)        NOT NULL COMMENT 'The call or chat it was found in',
  name                VARCHAR(80)     NOT NULL,
  name_key            VARCHAR(80)     NOT NULL,
  relation            ENUM('participant','mentioned') NOT NULL COMMENT 'Took part, or was talked about',
  category            ENUM('Investor','HNI','Business partner','Expert','Govt official','Vendor') NULL COMMENT 'Suggested by the AI',
  role_title          VARCHAR(120)    NULL,
  organisation        VARCHAR(120)    NULL,
  city                VARCHAR(60)     NULL,
  departments         SET('Investment','Sales','Channel partners','Accounts','Marketing','Tech & AI','Govt tenders','Vendors') NOT NULL DEFAULT '',
  interest            ENUM('high','medium','low','unknown') NOT NULL DEFAULT 'unknown',
  introduced_by_name  VARCHAR(80)     NULL,
  context             VARCHAR(1000)   NOT NULL COMMENT 'What was said about them',
  quote               VARCHAR(500)    NULL,
  evidence            JSON            NOT NULL COMMENT 'The lines it comes from: [{id, speaker, time_label, text, english}]',
  status              ENUM('pending','added','ignored') NOT NULL DEFAULT 'pending',
  person_id           CHAR(32)        NULL COMMENT 'The person it was added as (status added)',
  decided_at          DATETIME(3)     NULL,
  created_at          DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_person_suggestions_job_name (job_id, name_key),
  KEY ix_person_suggestions_status (status, created_at),
  KEY ix_person_suggestions_name_key (name_key),
  CONSTRAINT fk_person_suggestions_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_person_suggestions_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
