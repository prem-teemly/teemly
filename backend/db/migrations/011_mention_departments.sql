-- The departments each conversation gave a person, kept with the mention.
--
-- A call can now be moved from one person to another (two people with the same name). The person it
-- is taken from then has their facts worked out again from the conversations they still have; for
-- that, each mention keeps the departments it added. NULL = recorded before this migration (unknown),
-- in which case the person's departments are left as they are.

ALTER TABLE person_mentions
  ADD COLUMN departments VARCHAR(1000) NULL COMMENT 'Comma-separated department names this conversation gave the person' AFTER city;
