-- New departments suggested in conversations.
--
-- When someone in a call or chat says the owner should start a new team or department ("you need a
-- customer success team for all these shops"), the AI suggests it in the inbox: the name, who would
-- belong there, why, who said it and the lines that show it. Departments that already exist are
-- never suggested. The owner creates it (it then appears in Departments and Settings) or ignores it.

CREATE TABLE department_suggestions (
  id             CHAR(32)       NOT NULL COMMENT 'Random public id',
  job_id         CHAR(32)       NOT NULL COMMENT 'The conversation it was said in',
  name           VARCHAR(40)    NOT NULL,
  name_key       VARCHAR(40)    NOT NULL COMMENT 'Lower case, for "already suggested / already exists"',
  description    VARCHAR(300)   NULL COMMENT 'Who would belong there (given to the AI once created)',
  reason         VARCHAR(300)   NULL COMMENT 'Why it was suggested, from what was said',
  said_by        VARCHAR(80)    NULL COMMENT 'Who suggested it in the conversation',
  evidence       JSON           NOT NULL COMMENT 'Cited lines: [{id, speaker, time_label, text, english}]',
  status         ENUM('pending','created','ignored') NOT NULL DEFAULT 'pending',
  department_id  CHAR(32)       NULL COMMENT 'The department created from it',
  created_at     DATETIME(3)    NOT NULL,
  decided_at     DATETIME(3)    NULL,
  updated_at     DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_department_suggestions_job_name (job_id, name_key),
  KEY ix_department_suggestions_status (status, created_at),
  CONSTRAINT fk_department_suggestions_job FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
