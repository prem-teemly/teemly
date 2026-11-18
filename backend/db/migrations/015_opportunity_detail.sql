-- One opportunity's page: the owner's own chance, and the AI's view ("Will it work out?").
--
-- chance_pct: when the owner accepts the AI's suggested chance (or sets one), it replaces the stage's
-- chance for this deal in the weighted pipeline. NULL = the stage's chance. Moving the deal to another
-- stage clears it (the new stage's chance applies until a new one is accepted).
--
-- opportunity_insights: the AI's view of one deal, read from the calls and chats with that person,
-- saved so the page opens at once; based_on lists the conversations it read, so a new call shows it
-- is out of date and it can be refreshed.

ALTER TABLE opportunities
  ADD COLUMN chance_pct TINYINT UNSIGNED NULL COMMENT 'Owner-set chance (0-100) replacing the stage chance; NULL = stage chance' AFTER value_inr;

CREATE TABLE opportunity_insights (
  opportunity_id  CHAR(32)       NOT NULL,
  data            JSON           NOT NULL COMMENT '{ factors, would_change, suggested_chance_pct, details }',
  based_on        JSON           NOT NULL COMMENT 'Job ids of the conversations it read',
  model           VARCHAR(128)   NULL,
  created_at      DATETIME(3)    NOT NULL,
  PRIMARY KEY (opportunity_id),
  CONSTRAINT fk_opportunity_insights_opportunity FOREIGN KEY (opportunity_id) REFERENCES opportunities (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
