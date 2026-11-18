-- A goal per department, set by the owner on the department's page: e.g. Investment "Seed round",
-- target 2 crore. The pipeline is shown against it. Both are optional; nothing is guessed.

ALTER TABLE departments
  ADD COLUMN goal_label VARCHAR(60) NULL COMMENT 'e.g. Seed round' AFTER description,
  ADD COLUMN target_inr BIGINT UNSIGNED NULL COMMENT 'Goal in rupees, e.g. 20000000 for 2 crore' AFTER goal_label;
