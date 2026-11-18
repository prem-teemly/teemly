-- Teemly login: phone number + one-time code (OTP), and sessions.
--
-- Data protection: phone numbers are never stored in plain text. Each is stored as a keyed hash
-- (HMAC-SHA256 with AUDIT_HASH_KEY) for lookup, plus the last 4 digits for display ("••••210").
-- OTP codes are stored only as a keyed hash and expire after a few minutes; session tokens are stored
-- only as a SHA-256 hash, so a database leak cannot be used to sign in.

CREATE TABLE users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_hash     CHAR(64)        NOT NULL COMMENT 'HMAC-SHA256 of the E.164 number (keyed)',
  phone_last4    CHAR(4)         NOT NULL COMMENT 'For display only, e.g. ••••0210',
  country_code   VARCHAR(4)      NOT NULL DEFAULT '+91',
  display_name   VARCHAR(80)     NOT NULL,
  role           ENUM('owner','member') NOT NULL DEFAULT 'owner',
  status         ENUM('active','disabled') NOT NULL DEFAULT 'active',
  last_login_at  DATETIME(3)     NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_phone_hash (phone_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE otp_challenges (
  id             CHAR(32)        NOT NULL COMMENT 'Random challenge id returned to the client',
  phone_hash     CHAR(64)        NOT NULL,
  code_hash      CHAR(64)        NOT NULL COMMENT 'HMAC-SHA256 of the code; the code itself is never stored',
  attempts       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at     DATETIME(3)     NOT NULL,
  consumed_at    DATETIME(3)     NULL COMMENT 'Set when used, superseded or locked',
  client_hash    CHAR(64)        NULL COMMENT 'Keyed hash of the client address (no raw IP)',
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_otp_phone_created (phone_hash, created_at),
  KEY ix_otp_client_created (client_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash     CHAR(64)        NOT NULL COMMENT 'SHA-256 of the session token; the token lives only in the httpOnly cookie',
  user_id        BIGINT UNSIGNED NOT NULL,
  expires_at     DATETIME(3)     NOT NULL,
  last_seen_at   DATETIME(3)     NOT NULL,
  revoked_at     DATETIME(3)     NULL,
  client_hash    CHAR(64)        NULL,
  user_agent     VARCHAR(255)    NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token_hash (token_hash),
  KEY ix_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
