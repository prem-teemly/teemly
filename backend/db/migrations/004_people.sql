-- People found in calls and chats.
--
-- After a call or chat is analysed, the people who took part in it (other than the owner) and the
-- people who were talked about ("Deepan is an angel investor in Chennai") are stored here, with what
-- was said about them. One row per person (matched by name); one mention per person per call.
--
-- Only what the conversation itself says is stored: every mention cites the transcript lines it comes
-- from, and a city is stored only when it is actually said. Deleting a person deletes their mentions.

CREATE TABLE people (
  id                CHAR(32)        NOT NULL COMMENT 'Random public id (used in URLs)',
  name              VARCHAR(80)     NOT NULL COMMENT 'Name as spoken, in English letters',
  name_key          VARCHAR(80)     NOT NULL COMMENT 'Lower-case name without honorifics, for matching across calls',
  category          ENUM('Investor','HNI','Business partner','Expert','Govt official','Vendor') NULL COMMENT 'NULL = not clear yet',
  role_title        VARCHAR(120)    NULL COMMENT 'e.g. Angel investor, Chartered accountant',
  organisation      VARCHAR(120)    NULL,
  city              VARCHAR(60)     NULL,
  departments       SET('Investment','Sales','Channel partners','Accounts','Marketing','Tech & AI','Govt tenders','Vendors') NOT NULL DEFAULT '',
  score             TINYINT UNSIGNED NOT NULL DEFAULT 50 COMMENT '0-100, from the interest shown across calls',
  consent           ENUM('Yes','No','Ask') NOT NULL DEFAULT 'Ask',
  introduced_by_id  CHAR(32)        NULL,
  summary           VARCHAR(1000)   NULL COMMENT 'What the latest call said about this person',
  first_seen_at     DATETIME(3)     NOT NULL,
  last_contact_at   DATETIME(3)     NOT NULL,
  last_contact_kind ENUM('audio','whatsapp') NOT NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_people_name_key (name_key),
  KEY ix_people_category (category),
  KEY ix_people_city (city),
  KEY ix_people_last_contact (last_contact_at),
  CONSTRAINT fk_people_introduced_by FOREIGN KEY (introduced_by_id) REFERENCES people (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE person_mentions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  person_id           CHAR(32)        NOT NULL,
  job_id              CHAR(32)        NOT NULL,
  relation            ENUM('participant','mentioned') NOT NULL COMMENT 'Took part in the call, or was talked about',
  category            ENUM('Investor','HNI','Business partner','Expert','Govt official','Vendor') NULL COMMENT 'As stated in this call',
  role_title          VARCHAR(120)    NULL,
  organisation        VARCHAR(120)    NULL,
  city                VARCHAR(60)     NULL,
  interest            ENUM('high','medium','low','unknown') NOT NULL DEFAULT 'unknown',
  introduced_by_name  VARCHAR(80)     NULL,
  context             VARCHAR(1000)   NOT NULL COMMENT 'What was said about them in this call',
  quote               VARCHAR(500)    NULL,
  evidence_lines      JSON            NOT NULL COMMENT 'Transcript line numbers this comes from',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_person_mentions_person_job (person_id, job_id),
  KEY ix_person_mentions_job (job_id),
  CONSTRAINT fk_person_mentions_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE CASCADE,
  CONSTRAINT fk_person_mentions_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
