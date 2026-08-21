import { withUser } from "../lib/session.js";
import { uid, json, errors } from "../lib/db.js";

export async function onRequestGet(context) {
  const { env, user } = await withUser(context);
  if (!user) return errors.unauthenticated();

  const rows = await env.DB.prepare(
    `SELECT p.id, p.title, p.status, p.planned_days, m.role
     FROM productions p JOIN production_members m ON m.production_id = p.id
     WHERE m.user_id = ? ORDER BY p.created_at DESC`
  ).bind(user.id).all();

  return json({ productions: rows.results });
}

export async function onRequestPost(context) {
  const { request, env, user } = await withUser(context);
  if (!user) return errors.unauthenticated();

  let body;
  try { body = await request.json(); } catch { return errors.badRequest("Body must be JSON."); }
  if (!body?.title?.trim()) return errors.badRequest("A production title is required.");

  const id = uid("prod");
  await env.DB.prepare(
    `INSERT INTO productions (id, workspace_id, title, format, currency, territory, company, planned_days, status)
     VALUES (?,?,?,?,?,?,?,?, 'Prep')`
  ).bind(id, body.workspaceId || (await env.DB.prepare("SELECT workspace_id FROM users WHERE id = ?").bind(user.id).first()).workspace_id,
    body.title.trim(), body.format || "Feature", body.currency || "INR", body.territory || "",
    body.company || "", Number(body.plannedDays) || 0).run();

  // The person who creates a production is its producer — every other
  // role is granted later via manage_members.
  await env.DB.prepare("INSERT INTO production_members (production_id, user_id, role) VALUES (?,?,'producer')")
    .bind(id, user.id).run();

  return json({ id }, 201);
}
