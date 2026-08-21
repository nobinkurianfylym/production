import { withUser } from "../../lib/session.js";
import { actions } from "../../lib/actions.js";
import { assertMember, json, errors } from "../../lib/db.js";

export async function onRequestPost(context) {
  const { request, env, user, params } = await withUser(context);
  if (!user) return errors.unauthenticated();

  const member = await assertMember(env.DB, params.id, user.id);
  if (!member) return errors.forbidden("You are not a member of this production.");

  let body;
  try { body = await request.json(); } catch { return errors.badRequest("Body must be JSON."); }
  const { type, payload } = body || {};
  const handler = actions[type];
  if (!handler) return errors.badRequest(`Unknown action "${type}".`);

  try {
    const result = await handler(env.DB, params.id, member, user, payload || {});
    return json({ ok: true, result });
  } catch (e) {
    // requireCan and the handlers throw Errors with a .status attached
    // (403 for permission, 409 for a locked record, 404 for a missing
    // reference). Anything without a .status is a genuine bug, not a
    // rule the caller broke, so it comes back as a 500 with no detail
    // leaked to the client.
    if (e.status) return json({ error: e.message }, e.status);
    console.error("action error", type, e);
    return json({ error: "Something went wrong processing that action." }, 500);
  }
}
