-- Seven opportunity stages (as in the product design) and a log of every stage move.
--
--   Identified -> First contact -> In discussion -> Pitch / bid shared -> Negotiation -> Committed -> Won
--   (+ Lost)
--
-- "Proposal" becomes "Pitch / bid shared"; every other stage keeps its name, so no opportunity is
-- lost or moved. The column is first widened to hold both the old and the new names, the rows are
-- renamed, then the old name is dropped.
--
-- opportunity_stage_changes records each move (by the owner on the opportunity panel or a person's
-- page, or by the AI when a later call moves a deal forward), for "every move is logged".

ALTER TABLE opportunities
  MODIFY stage ENUM('Identified','First contact','In discussion','Proposal','Pitch / bid shared','Negotiation','Committed','Won','Lost') NOT NULL DEFAULT 'Identified';

UPDATE opportunities SET stage = 'Pitch / bid shared' WHERE stage = 'Proposal';

ALTER TABLE opportunities
  MODIFY stage ENUM('Identified','First contact','In discussion','Pitch / bid shared','Negotiation','Committed','Won','Lost') NOT NULL DEFAULT 'Identified';

CREATE TABLE opportunity_stage_changes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  opportunity_id  CHAR(32)        NOT NULL,
  from_stage      VARCHAR(30)     NULL COMMENT 'NULL = created at to_stage',
  to_stage        VARCHAR(30)     NOT NULL,
  changed_by      ENUM('owner','ai') NOT NULL DEFAULT 'owner',
  source_job_id   CHAR(32)        NULL COMMENT 'The conversation that moved it (AI)',
  created_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_stage_changes_opportunity (opportunity_id, created_at),
  CONSTRAINT fk_stage_changes_opportunity FOREIGN KEY (opportunity_id) REFERENCES opportunities (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
