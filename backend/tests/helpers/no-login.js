// Import first in test files that are not about sign-in: keeps login OFF even when backend/.env sets
// OWNER_EMAIL (dotenv never overrides a variable that is already set, even to "").
process.env.OWNER_EMAIL = "";
process.env.OWNER_PHONE = "";
