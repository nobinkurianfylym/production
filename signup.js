import { hashPassword, newSessionToken, sessionCookie, SESSION_DAYS } from "../lib/auth.js";
import { uid, json, errors } from "../lib/db.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  if (!env.DB) return errors.badRequest("Database is not bound. See README — D1 setup.");

  let body;
  try { body = await request.json(); } catch { return errors.badRequest("Body must be JSON."); }
  const { workspaceName, name, email, password } = body || {};

  if (!workspaceName?.trim()) return errors.badRequest("Company or workspace name is required.");
  if (!name?.trim()) return errors.badRequest("Your name is required.");
  if (!EMAIL_RE.test(email || "")) return errors.badRequest("A valid email is required.");
  if (!password || password.length < 10) return errors.badRequest("Password must be at least 10 characters.");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first();
  if (existing) return errors.badRequest("An account with that email already exists. Try signing in instead.");

  const wsId = uid("ws");
  const userId = uid("u");
  const { hash, salt } = await hashPassword(password, env);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").bind(wsId, workspaceName.trim()),
    env.DB.prepare(
      "INSERT INTO users (id, workspace_id, email, name, password_hash, password_salt) VALUES (?,?,?,?,?,?)"
    ).bind(userId, wsId, email.toLowerCase(), name.trim(), hash, salt),
  ]);

  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)")
    .bind(token, userId, expires).run();

  return json(
    { user: { id: userId, name: name.trim(), email: email.toLowerCase() }, workspace: { id: wsId, name: workspaceName.trim() } },
    201,
    { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) }
  );
}
