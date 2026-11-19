-- Passwords, next to the one-time code: an account can sign in with its email and a password (fast,
-- no email to wait for), or with an emailed code as before (always available: a forgotten password
-- never locks anyone out, and "Forgot password" sets a new one after a code).
--
-- What is stored, and what is not:
--   password_hash   scrypt of the password with a random 16-byte salt, as
--                   "scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>". The password itself is never
--                   stored or logged; a database leak does not reveal it.
--   password_set_at when it was set or last changed (shown on the profile).
--   failed_logins   wrong passwords in a row; 5 lock password sign-in for 15 minutes (locked_until).
--                   A correct password or an emailed code clears both.
-- Sign-ins, failures, lockouts and password changes are recorded in audit_logs (with the client
-- address only as a keyed hash).
ALTER TABLE users
  ADD COLUMN password_hash   VARCHAR(255)      NULL COMMENT 'scrypt$N$r$p$salt$hash; NULL = no password (email code only)' AFTER email,
  ADD COLUMN password_set_at DATETIME(3)       NULL COMMENT 'When the password was set or last changed' AFTER password_hash,
  ADD COLUMN failed_logins   SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Wrong passwords in a row' AFTER status,
  ADD COLUMN locked_until    DATETIME(3)       NULL COMMENT 'Password sign-in locked until then (too many wrong passwords)' AFTER failed_logins;
