-- Teemly: databases and least-privilege users. Run ONCE as a MySQL administrator, e.g.
--   & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p < create_users.sql
-- Replace both placeholders with the passwords from backend/.env (DB_PASSWORD, DB_MIGRATION_PASSWORD).
-- Existing databases, tables, data and users are not changed (IF NOT EXISTS everywhere).

CREATE DATABASE IF NOT EXISTS teemly_db      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS teemly_db_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Runtime user used by the backend: data access only, from this machine only.
CREATE USER IF NOT EXISTS 'teemly_app'@'localhost' IDENTIFIED BY '__APP_PASSWORD__';
GRANT SELECT, INSERT, UPDATE, DELETE ON teemly_db.*      TO 'teemly_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON teemly_db_test.* TO 'teemly_app'@'localhost';

-- Migration user: schema changes (npm run db:migrate), from this machine only.
CREATE USER IF NOT EXISTS 'teemly_migrator'@'localhost' IDENTIFIED BY '__MIGRATOR_PASSWORD__';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON teemly_db_test.* TO 'teemly_migrator'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON teemly_db.* TO 'teemly_migrator'@'localhost';

-- Audit: what already exists in teemly_db (nothing is modified).
SELECT TABLE_NAME AS existing_table_in_teemly_db, TABLE_ROWS AS approx_rows
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'teemly_db' ORDER BY TABLE_NAME;
SELECT user, host FROM mysql.user WHERE user IN ('teemly_app', 'teemly_migrator');
