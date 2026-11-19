// Import first in test files that are not about sign-in: every request runs as one fixed test user
// without a session (config.testUser: NODE_ENV=test and TEST_USER_ID). server.js refuses NODE_ENV=test,
// so this can never apply to a real server. Tests that use MySQL create this user (tests/helpers/db-user.js).
process.env.NODE_ENV = "test";
process.env.TEST_USER_ID = process.env.TEST_USER_ID || "1";
process.env.TEST_USER_NAME = process.env.TEST_USER_NAME || "Test Owner";
process.env.OWNER_EMAIL = "";
process.env.OWNER_PHONE = "";
