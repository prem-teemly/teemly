// MySQL tests: the account that tests/helpers/no-login.js runs every request as (TEST_USER_ID), with
// its room (built-in departments), as a real sign-up would make it. Test database only.

/** Make sure the test user (and its departments) exist; returns its id. */
export async function ensureTestUser(pool, { id = Number(process.env.TEST_USER_ID), name = process.env.TEST_USER_NAME } = {}) {
  const [[{ db }]] = await pool.query("SELECT DATABASE() AS db");
  if (db !== "teemly_db_test") throw new Error(`refusing to create a test user in ${db}`);
  await pool.query(
    "INSERT INTO users (id, email, display_name, role, status) VALUES (?, ?, ?, 'owner', 'active') ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = 'active'",
    [id, `test-user-${id}@example.com`, name],
  );
  const { seedDepartments } = await import("../../src/db/departments.js");
  const conn = await pool.getConnection();
  try {
    const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM departments WHERE user_id = ?", [id]);
    if (!Number(n)) await seedDepartments(conn, id);
  } finally {
    conn.release();
  }
  return id;
}

/**
 * Delete accounts and everything in their rooms (test database only), children before parents so no
 * foreign key is in the way. `where` selects users, e.g. "email IS NULL OR email LIKE '%@example.org'".
 */
export async function deleteUsers(pool, where, params = []) {
  const [[{ db }]] = await pool.query("SELECT DATABASE() AS db");
  if (db !== "teemly_db_test") throw new Error(`refusing to delete users in ${db}`);
  const [rows] = await pool.query(`SELECT id FROM users WHERE ${where}`, params);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return 0;
  for (const t of ["notification_facts", "notifications", "app_settings", "opportunities", "person_notes", "person_suggestions", "department_suggestions", "people", "departments", "exports", "audio_uploads", "processing_jobs", "audio_files"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [ids]);
  }
  await pool.query("DELETE FROM users WHERE id IN (?)", [ids]); // sessions cascade; audit rows keep, unlinked
  return ids.length;
}

/** A module whose functions run as the test user (for tests that call the database layer directly). */
export async function asTestUser(mod) {
  const { runAs } = await import("../../src/tenant.js");
  const { testUser } = await import("../../src/config.js");
  return new Proxy(mod, { get: (m, k) => (typeof m[k] === "function" ? (...a) => runAs(testUser(), () => m[k](...a)) : m[k]) });
}
