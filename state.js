import { withUser } from "../../lib/session.js";
import { assembleState } from "../../lib/actions.js";
import { assertMember } from "../../lib/db.js";
import { json, errors } from "../../lib/db.js";

export async function onRequestGet(context) {
  const { env, user, params } = await withUser(context);
  if (!user) return errors.unauthenticated();

  const member = await assertMember(env.DB, params.id, user.id);
  if (!member) return errors.forbidden("You are not a member of this production.");

  const state = await assembleState(env.DB, params.id);
  if (!state) return errors.notFound("Production");

  // Financial fields are stripped for roles that shouldn't see them
  // (FR-ROLE-004). This happens here, server-side, not by hiding a column
  // in the UI — a role without view_rates never receives the rate at all.
  const canSeeRates = ["producer", "line_producer", "accountant"].includes(member.role);
  if (!canSeeRates) {
    state.people = state.people.map((p) => ({ ...p, rate: null }));
    state.accounts = state.accounts.map((a) => ({ ...a, lines: a.lines.map((l) => ({ ...l, rate: null })) }));
  }

  return json({ state, member: { role: member.role, department: member.department } });
}
