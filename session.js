import { parseCookie } from "./auth.js";

/* Attaches `context.user` from the session cookie, or null if there isn't
   a valid one. Does NOT reject unauthenticated requests itself — signup
   and signin have to work without a session. Endpoints that require a
   signed-in user check `context.user` themselves and return 401. */
export async function withUser(context) {
  const { request, env } = context;
  if (!env.DB) return { ...context, user: null };

  const token = parseCookie(request.headers.get("Cookie"), "fpms_session");
  if (!token) return { ...context, user: null };

  const row = await env.DB.prepare(
    `SELECT u.id, u.workspace_id, u.name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();

  return { ...context, user: row || null };
}
