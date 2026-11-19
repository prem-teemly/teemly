// Who the current work is for: the signed-in user (one room per user).
//
// Every row a user owns carries their users.id (user_id, migration 023), and every query on those rows
// filters by it. The id comes from here, not from function arguments: a request runs inside
// runAs(req.user, ...) (set by the auth middleware and by each route handler), and a background job
// runs inside runAs(job.owner, ...).
//
// Fail closed: uid() throws when there is no user, so a query that somehow runs outside a user's
// context is an error, never a read of everybody's rows.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export class NoUserContext extends Error {
  constructor() {
    super("No signed-in user for this operation (tenant context missing).");
    this.name = "NoUserContext";
  }
}

/** Run fn as `user` ({ id, name }); everything it awaits sees the same user. */
export function runAs(user, fn) {
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) throw new NoUserContext();
  return storage.run(Object.freeze({ id: Number(user.id), name: String(user.name ?? "").trim() || "Owner" }), fn);
}

/** The current user ({ id, name }); throws NoUserContext outside a user's context. */
export function currentUser() {
  const u = storage.getStore();
  if (!u) throw new NoUserContext();
  return u;
}

/** The current user's id, for `WHERE user_id = ?`. Throws outside a user's context. */
export const uid = () => currentUser().id;

/** The current user, or null (logging and audit only: never use this to filter data). */
export const maybeUser = () => storage.getStore() ?? null;

/** The current user's display name, or "Owner" outside a user's context (AI prompts, labels). */
export const ownerName = () => storage.getStore()?.name ?? "Owner";
