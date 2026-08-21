import { clearSessionCookie, parseCookie } from "../lib/auth.js";
import { json, errors } from "../lib/db.js";

export async function onRequestPost({ request, env }) {
  const token = parseCookie(request.headers.get("Cookie"), "fpms_session");
  if (token && env.DB) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
