-- Each department's page has its own dashboard, made for what that team does: investors, a sales
-- pipeline, partners, suppliers, tenders with deadlines, or the standard page. view_type is chosen in
-- Settings; NULL = chosen from the department's name (Sales -> sales, Vendors -> suppliers, ...).

ALTER TABLE departments
  ADD COLUMN view_type VARCHAR(24) NULL COMMENT 'investors | sales | partners | suppliers | tenders | standard; NULL = from the name' AFTER target_inr;
