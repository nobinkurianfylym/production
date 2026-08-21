/* Wraps node:sqlite's DatabaseSync so it exposes D1's binding API
   (.prepare().bind().run()/.all()/.first(), plus .batch()). This is TEST
   INFRASTRUCTURE ONLY — it exists so functions/api/lib/actions.js can be
   exercised against a real SQLite engine before it ever touches a real D1
   database. The Worker code imports nothing from this file; it only ever
   sees `env.DB`, which in production is the real D1 binding. */
import { DatabaseSync } from "node:sqlite";

function wrapStatement(db, sql) {
  let bound = [];
  const api = {
    bind(...params) { bound = params; return api; },
    async run() {
      const stmt = db.prepare(sql);
      const info = stmt.run(...bound);
      return { success: true, meta: { last_row_id: info.lastInsertRowid, changes: info.changes } };
    },
    async all() {
      const stmt = db.prepare(sql);
      return { success: true, results: stmt.all(...bound) };
    },
    async first() {
      const stmt = db.prepare(sql);
      const row = stmt.get(...bound);
      return row === undefined ? null : row;
    },
  };
  return api;
}

export function makeTestD1(sqlSchema) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(sqlSchema);
  return {
    prepare(sql) { return wrapStatement(db, sql); },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    _raw: db, // escape hatch for test setup/assertions only
  };
}
