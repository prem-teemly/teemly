-- Departments the owner can add to (Settings > Departments).
--
-- Until now the eight departments were fixed in the column types (SET / ENUM), so no new department
-- could be stored. They now live in their own table: the eight built-in ones plus any the owner adds,
-- each with a colour and a short "who belongs here" description that the AI uses when it sorts the
-- people and opportunities of a call into departments.
--
-- people.departments and person_suggestions.departments keep the same comma-separated values (a
-- MySQL SET already reads as "Investment,Sales"), and opportunities.department keeps its name, so
-- every existing row stays exactly as it was. Department names cannot contain commas.

CREATE TABLE departments (
  id           CHAR(32)       NOT NULL COMMENT 'Random public id',
  slug         VARCHAR(60)    NOT NULL COMMENT 'For URLs, e.g. channel-partners',
  name         VARCHAR(40)    NOT NULL COMMENT 'As stored on people and opportunities; no commas',
  color        CHAR(7)        NOT NULL COMMENT 'Hex colour, e.g. #6c63f6',
  description  VARCHAR(300)   NULL COMMENT 'Who belongs here; given to the AI',
  built_in     TINYINT(1)     NOT NULL DEFAULT 0 COMMENT '1 = one of the eight original departments (cannot be deleted)',
  sort_order   INT            NOT NULL DEFAULT 0,
  created_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_slug (slug),
  UNIQUE KEY uq_departments_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO departments (id, slug, name, color, description, built_in, sort_order) VALUES
  (REPLACE(UUID(), '-', ''), 'investment', 'Investment', '#6c63f6', 'Investors and HNIs who invest or may invest money in the owner''s company: angels, VCs, funds, wealthy individuals', 1, 10),
  (REPLACE(UUID(), '-', ''), 'sales', 'Sales', '#2fae6a', 'Customers and buyers, and partners who bring direct sales', 1, 20),
  (REPLACE(UUID(), '-', ''), 'channel-partners', 'Channel partners', '#18a7b5', 'Distributors, resellers and partners who sell or refer the owner''s product', 1, 30),
  (REPLACE(UUID(), '-', ''), 'accounts', 'Accounts', '#64748b', 'Chartered accountants, auditors, tax and finance people', 1, 40),
  (REPLACE(UUID(), '-', ''), 'marketing', 'Marketing', '#e2507a', 'Marketing and advertising agencies, PR, designers, influencers', 1, 50),
  (REPLACE(UUID(), '-', ''), 'tech-ai', 'Tech & AI', '#3b82f6', 'Developers, AI and tech experts, technical advisors', 1, 60),
  (REPLACE(UUID(), '-', ''), 'govt-tenders', 'Govt tenders', '#d4891b', 'Government officials and contacts for government tenders and bids', 1, 70),
  (REPLACE(UUID(), '-', ''), 'vendors', 'Vendors', '#9a6b4b', 'Suppliers of goods or services to the owner: hardware, printing, contractors', 1, 80);

ALTER TABLE people MODIFY departments VARCHAR(1000) NOT NULL DEFAULT '' COMMENT 'Comma-separated department names';

ALTER TABLE person_suggestions MODIFY departments VARCHAR(1000) NOT NULL DEFAULT '' COMMENT 'Comma-separated department names';

ALTER TABLE opportunities MODIFY department VARCHAR(40) NULL COMMENT 'Department name (departments.name)';
