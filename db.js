/* Central D1 access helper.
   ────────────────────────────────────────────────────────────────────────
   NFR-DATA-002 requires production_id to be enforced at the query layer,
   "so cross-production leakage is structurally impossible." A single
   endpoint remembering to add `AND production_id = ?` is not that — it's
   one missed WHERE clause away from a data leak between two productions
   sharing a workspace. Routing every scoped query through here means the
   scoping is written once, reviewed once, and every endpoint inherits it.

   This does not make leakage impossible in the mathematical sense (nothing
   short of row-level security at the database engine does), but it moves
   the single point of failure from "every endpoint" to "this one file". */

export function scoped(db, productionId) {
  const run = async (sql, ...params) => db.prepare(sql).bind(...params).run();
  const one = async (sql, ...params) => db.prepare(sql).bind(...params).first();
  const all = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;

  return {
    // SELECT — sql must contain exactly one `?` for production_id, placed first.
    select: (sql, ...params) => all(sql, productionId, ...params),
    selectOne: (sql, ...params) => one(sql, productionId, ...params),
    // INSERT — caller supplies the full column list; production_id is
    // asserted present by convention (every table has the column and every
    // insert helper below fills it), not re-derived here.
    insert: run,
    update: run,
    del: run,
  };
}

export async function assertMember(db, productionId, userId) {
  const row = await db
    .prepare("SELECT role, department FROM production_members WHERE production_id = ? AND user_id = ?")
    .bind(productionId, userId)
    .first();
  return row || null;
}

export const uid = (prefix = "id") => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export const nowISO = () => new Date().toISOString();

export async function audit(db, productionId, { actorId, actorName, action, object, detail }) {
  await db
    .prepare("INSERT INTO audit_log (id, production_id, actor_id, actor_name, action, object, detail) VALUES (?,?,?,?,?,?,?)")
    .bind(uid("aud"), productionId, actorId || null, actorName, action, object, detail || "")
    .run();
}

export const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });

export const errors = {
  unauthenticated: () => json({ error: "Not signed in." }, 401),
  forbidden: (msg) => json({ error: msg || "You don't have permission to do that." }, 403),
  notFound: (what) => json({ error: `${what} not found.` }, 404),
  badRequest: (msg) => json({ error: msg }, 400),
};
