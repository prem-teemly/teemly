-- The owner adds a person by hand ("+ Add" → Add person), before any call or chat with them.
-- last_contact_kind 'added' = added by the owner, no conversation yet; last_contact_at is when they were
-- added. Their first call or chat replaces it ('audio' / 'whatsapp'), as for everyone else.

ALTER TABLE people
  MODIFY last_contact_kind ENUM('audio','whatsapp','added') NOT NULL COMMENT 'added = added by the owner, no call or chat yet';
