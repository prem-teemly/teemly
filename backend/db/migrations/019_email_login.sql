-- Login by email + one-time code (replaces phone + code). Nothing is deleted: the phone columns stay
-- (no longer required) and the existing owner account is kept; on the first email sign-in it is linked
-- to the owner's email, so its sessions, devices and history continue.
--
-- users.email: the sign-in email, lower case (unique; needed to send the code). Phone columns become
-- optional. otp_challenges.email_hash: keyed hash of the email the code was sent to (the email itself
-- is never stored there, like the phone hash). A challenge has a phone hash or an email hash.

ALTER TABLE users
  ADD COLUMN email VARCHAR(254) NULL COMMENT 'Sign-in email, lower case' AFTER id,
  MODIFY phone_hash CHAR(64) NULL COMMENT 'HMAC-SHA256 of the E.164 number (keyed); phone sign-in, no longer used',
  MODIFY phone_last4 CHAR(4) NULL COMMENT 'For display only; phone sign-in, no longer used',
  ADD UNIQUE KEY uq_users_email (email);

ALTER TABLE otp_challenges
  ADD COLUMN email_hash CHAR(64) NULL COMMENT 'HMAC-SHA256 of the lower-case email (keyed)' AFTER phone_hash,
  MODIFY phone_hash CHAR(64) NULL,
  ADD KEY ix_otp_email_created (email_hash, created_at);
