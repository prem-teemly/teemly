-- A call or chat added from a person's page ("Add file") belongs to that person.
--
-- processing_jobs.person_id is set when the file was uploaded on a person's page: when the job
-- finishes, the conversation is put on that person's timeline even if the AI does not hear their name.
-- NULL for files uploaded on the call screen. Deleting the person keeps the job (the link is cleared).

ALTER TABLE processing_jobs
  ADD COLUMN person_id CHAR(32) NULL COMMENT 'Uploaded from this person''s page' AFTER audio_file_id,
  ADD KEY ix_processing_jobs_person (person_id),
  ADD CONSTRAINT fk_processing_jobs_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE SET NULL;
