import { withUser } from "../../lib/session.js";
import { requireCan } from "../../lib/permissions.js";
import { assertMember, json, errors } from "../../lib/db.js";

export async function onRequestGet(context) {
  const { env, user, params } = await withUser(context);
  if (!user) return errors.unauthenticated();
  const member = await assertMember(env.DB, params.id, user.id);
  if (!member) return errors.forbidden("You are not a member of this production.");

  const rows = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, m.role, m.department
     FROM production_members m JOIN users u ON u.id = m.user_id
     WHERE m.production_id = ?`
  ).bind(params.id).all();
  return json({ members: rows.results });
}

export async function onRequestPost(context) {
  const { request, env, user, params } = await withUser(context);
  if (!user) return errors.unauthenticated();
  const member = await assertMember(env.DB, params.id, user.id);
  if (!member) return errors.forbidden("You are not a member of this production.");

  try {
    requireCan(member, "manage_members");
  } catch (e) {
    return errors.forbidden(e.message);
  }

  let body;
  try { body = await request.json(); } catch { return errors.badRequest("Body must be JSON."); }
  const { email, role, department } = body || {};
  if (!email || !role) return errors.badRequest("Email and role are required.");

  // The invited person must already have an account — this app does not
  // send invitation email itself (see README, "distribution"). Have them
  // sign up first, then add them here by the email they used.
  const target = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first();
  if (!target) return errors.badRequest(`No account found for ${email}. Ask them to sign up first, then add them here.`);

  await env.DB.prepare(
    `INSERT INTO production_members (production_id, user_id, role, department) VALUES (?,?,?,?)
     ON CONFLICT(production_id, user_id) DO UPDATE SET role = excluded.role, department = excluded.department`
  ).bind(params.id, target.id, role, department || null).run();

  return json({ ok: true });
}
