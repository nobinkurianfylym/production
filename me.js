import { withUser } from "../lib/session.js";
import { json } from "../lib/db.js";

export async function onRequestGet(context) {
  const { user } = await withUser(context);
  return json({ user: user || null });
}
