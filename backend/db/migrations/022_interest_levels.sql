-- Interest in plain words instead of Hot / Warm / Cool: Very interested / Interested / Slightly
-- interested / Not interested / Not clear yet.
--   * the AI can now say "none" (they said plainly they are not interested);
--   * a person with no call that shows their interest has no score (NULL = "Not clear yet"), not 50;
--   * the score: the latest call weighs half, all earlier calls together the other half
--     (high 90, medium 65, low 40, none 10), as services/people.js interestScore() does.
-- Nothing is deleted: existing scores are worked out again from the calls already stored.

ALTER TABLE person_mentions
  MODIFY interest ENUM('high','medium','low','none','unknown') NOT NULL DEFAULT 'unknown';

ALTER TABLE person_suggestions
  MODIFY interest ENUM('high','medium','low','none','unknown') NOT NULL DEFAULT 'unknown';

ALTER TABLE people
  MODIFY score TINYINT UNSIGNED NULL DEFAULT NULL COMMENT '0-100 from the interest shown in calls (latest call weighs half); NULL = not clear yet';

UPDATE people p
  LEFT JOIN (
    SELECT person_id,
           MAX(CASE WHEN rn = 1 THEN pts END) AS latest,
           AVG(CASE WHEN rn > 1 THEN pts END) AS earlier
    FROM (
      SELECT person_id,
             CASE interest WHEN 'high' THEN 90 WHEN 'medium' THEN 65 WHEN 'low' THEN 40 WHEN 'none' THEN 10 END AS pts,
             ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at DESC, id DESC) AS rn
      FROM person_mentions
      WHERE interest IN ('high', 'medium', 'low', 'none')
    ) k
    GROUP BY person_id
  ) s ON s.person_id = p.id
SET p.score = CASE
  WHEN s.latest IS NULL THEN NULL
  WHEN s.earlier IS NULL THEN s.latest
  ELSE ROUND(s.latest * 0.5 + s.earlier * 0.5)
END;
