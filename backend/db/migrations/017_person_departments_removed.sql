-- The owner edits a person's departments on their page. Departments the owner takes a person out of
-- are remembered here, so a later call never puts the person back in them (the AI may still add other
-- departments). Putting the person back in a department removes it from this list.

ALTER TABLE people
  ADD COLUMN departments_removed VARCHAR(1000) NOT NULL DEFAULT '' COMMENT 'Comma-separated departments the owner took the person out of; calls never add these back' AFTER departments;
