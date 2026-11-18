-- Notes and opportunities on a person's page.
--
-- Notes: the owner's own notes about a person (pinned notes first). Opportunities: a deal or piece of
-- work with a person (e.g. "South TN distribution"), its stage, value in rupees, the next step and
-- when it is due, and optionally the call or chat it came from. Deleting a person deletes both;
-- deleting a conversation keeps the opportunity (the link is cleared).

CREATE TABLE person_notes (
  id          CHAR(32)        NOT NULL COMMENT 'Random public id',
  person_id   CHAR(32)        NOT NULL,
  body        VARCHAR(4000)   NOT NULL,
  pinned      TINYINT(1)      NOT NULL DEFAULT 0,
  created_at  DATETIME(3)     NOT NULL,
  updated_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_person_notes_person (person_id, pinned, created_at),
  CONSTRAINT fk_person_notes_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE opportunities (
  id             CHAR(32)        NOT NULL COMMENT 'Random public id',
  person_id      CHAR(32)        NOT NULL,
  title          VARCHAR(160)    NOT NULL,
  stage          ENUM('Identified','In discussion','Proposal','Won','Lost') NOT NULL DEFAULT 'Identified',
  department     ENUM('Investment','Sales','Channel partners','Accounts','Marketing','Tech & AI','Govt tenders','Vendors') NULL,
  value_inr      BIGINT UNSIGNED NULL COMMENT 'Expected value in rupees',
  next_step      VARCHAR(300)    NULL,
  due_date       DATE            NULL COMMENT 'When the next step is due',
  source_job_id  CHAR(32)        NULL COMMENT 'The call or chat it came from',
  closed_at      DATETIME(3)     NULL COMMENT 'Set when the stage becomes Won or Lost',
  created_at     DATETIME(3)     NOT NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_opportunities_person (person_id, stage),
  KEY ix_opportunities_stage (stage, due_date),
  CONSTRAINT fk_opportunities_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE CASCADE,
  CONSTRAINT fk_opportunities_job FOREIGN KEY (source_job_id) REFERENCES processing_jobs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
