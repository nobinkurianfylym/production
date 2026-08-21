import { verifyPassword, newSessionToken, sessionCookie, SESSION_DAYS } from "../lib/auth.js";
import { json, errors } from "../lib/db.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return errors.badRequest("Database is not bound. See README — D1 setup.");

  let body;
  try { body = await request.json(); } catch { return errors.badRequest("Body must be JSON."); }
  const { email, password } = body || {};
  if (!email || !password) return errors.badRequest("Email and password are required.");

  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first();
  // Same response whether the email doesn't exist or the password is wrong —
  // don't let a login form confirm which emails have accounts.
  if (!user || !(await verifyPassword(password, user.password_hash, user.password_salt))) {
    return errors.badRequest("Incorrect email or password.");
  }

  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)")
    .bind(token, user.id, expires).run();

  return json(
    { user: { id: user.id, name: user.name, email: user.email } },
    200,
    { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) }
  );
}
