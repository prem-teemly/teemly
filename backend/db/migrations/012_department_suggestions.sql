-- AI department suggestions for new people in the inbox.
--
-- When a call or chat brings up someone new, the AI suggests which of the owner's departments they
-- should go to, and why: a short reason taken from what was said, how sure it is, and the lines that
-- show it. The owner sees this on the inbox item and when adding the person, and can change it.
-- [{ department, reason, confidence: high|medium|low, evidence: [{ id, speaker, time_label, text, english }] }]

ALTER TABLE person_suggestions
  ADD COLUMN department_suggestions JSON NULL COMMENT 'AI: suggested departments with reason, confidence and evidence' AFTER departments;
