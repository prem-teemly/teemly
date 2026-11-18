-- Opportunities captured from calls and chats.
--
-- After a conversation is analysed, the AI lists the business opportunities with each person in it
-- (a sale, a distribution deal, an investment, a tender...). For someone already in People they are
-- added to the person's Opportunities straight away, with the conversation they came from and the
-- lines that say so. For someone new they wait on the inbox suggestion and are added when the owner
-- approves the person. Opportunities the owner adds by hand stay 'manual'.

ALTER TABLE opportunities
  ADD COLUMN origin   ENUM('manual','ai') NOT NULL DEFAULT 'manual' COMMENT 'ai = captured from the source conversation' AFTER source_job_id,
  ADD COLUMN evidence JSON NULL COMMENT 'Cited lines of the source conversation: [{id, speaker, time_label, start, text, english}]' AFTER origin;

ALTER TABLE person_suggestions
  ADD COLUMN opportunities JSON NULL COMMENT 'Opportunities found with this person, added when the suggestion is approved' AFTER evidence;
