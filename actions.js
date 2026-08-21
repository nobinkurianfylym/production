import { uid, nowISO, audit } from "./db.js";
import { requireCan } from "./permissions.js";

/* ── Budget math, computed in SQL so it can never drift from what the
   database actually holds (as opposed to recomputing it in JS from a
   payload the client sent). Mirrors accountBudget/accountActual/
   accountCommitted from the prototype's client-side logic — same formulas,
   now the authoritative version. ─────────────────────────────────────── */

async function accountFinancials(db, accountId) {
  const budgetRow = await db.prepare(
    `SELECT COALESCE(SUM(qty * rate * (1 + fringe)), 0) AS budget
     FROM budget_lines WHERE account_id = ?`
  ).bind(accountId).first();

  const actualRow = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS actual
     FROM expenses WHERE account_id = ? AND status = 'Approved'`
  ).bind(accountId).first();

  const committedRow = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS committed
     FROM purchase_orders WHERE account_id = ? AND status = 'Approved'`
  ).bind(accountId).first();

  const budget = budgetRow.budget, actual = actualRow.actual, committed = committedRow.committed;
  return { budget, actual, committed, available: budget - actual - committed };
}

/* ── Full state assembly — same shape the prototype's seedState() produced,
   so the existing derived-data functions (progress, dood, budgetTotals,
   alerts) keep working in the frontend without a rewrite. This is the one
   place that reads across every table for a production. ──────────────── */

export async function assembleState(db, productionId) {
  const prod = await db.prepare("SELECT * FROM productions WHERE id = ?").bind(productionId).first();
  if (!prod) return null;

  const [scenes, sceneCast, characters, locations, people, elements, elementScenes,
    days, strips, accounts, lines, pos, expenses, auditRows] = await Promise.all([
    db.prepare("SELECT * FROM scenes WHERE production_id = ? ORDER BY sort_order").bind(productionId).all(),
    db.prepare("SELECT sc.* FROM scene_cast sc JOIN scenes s ON s.id = sc.scene_id WHERE s.production_id = ?").bind(productionId).all(),
    db.prepare("SELECT * FROM characters WHERE production_id = ?").bind(productionId).all(),
    db.prepare("SELECT * FROM locations WHERE production_id = ?").bind(productionId).all(),
    db.prepare("SELECT * FROM people WHERE production_id = ?").bind(productionId).all(),
    db.prepare("SELECT * FROM elements WHERE production_id = ?").bind(productionId).all(),
    db.prepare("SELECT es.* FROM element_scenes es JOIN elements e ON e.id = es.element_id WHERE e.production_id = ?").bind(productionId).all(),
    db.prepare("SELECT * FROM shooting_days WHERE production_id = ? ORDER BY n").bind(productionId).all(),
    db.prepare("SELECT ds.* FROM day_strips ds JOIN shooting_days d ON d.id = ds.day_id WHERE d.production_id = ? ORDER BY ds.sort_order").bind(productionId).all(),
    db.prepare("SELECT * FROM accounts WHERE production_id = ?").bind(productionId).all(),
    db.prepare("SELECT bl.* FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id WHERE a.production_id = ?").bind(productionId).all(),
    db.prepare("SELECT * FROM purchase_orders WHERE production_id = ? ORDER BY date").bind(productionId).all(),
    db.prepare("SELECT * FROM expenses WHERE production_id = ? ORDER BY date").bind(productionId).all(),
    db.prepare("SELECT * FROM audit_log WHERE production_id = ? ORDER BY ts DESC LIMIT 200").bind(productionId).all(),
  ]);

  const castByScene = {};
  for (const r of sceneCast.results) (castByScene[r.scene_id] ??= []).push(r.character_id);

  const scenesByElement = {};
  for (const r of elementScenes.results) (scenesByElement[r.element_id] ??= []).push(r.scene_id);

  const stripsByDay = {};
  for (const r of strips.results) (stripsByDay[r.day_id] ??= []).push(r.scene_id);

  const linesByAccount = {};
  for (const r of lines.results) (linesByAccount[r.account_id] ??= []).push(r);

  const dprsRaw = await db.prepare("SELECT * FROM dprs WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?)").bind(productionId).all();
  const delayRows = await db.prepare("SELECT * FROM delays WHERE day_id IN (SELECT day_id FROM dprs WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?))").bind(productionId).all();
  const incidentRows = await db.prepare("SELECT * FROM incidents WHERE day_id IN (SELECT day_id FROM dprs WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?))").bind(productionId).all();
  const dprScenes = await db.prepare("SELECT * FROM dpr_scenes WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?)").bind(productionId).all();

  const dprs = {};
  for (const d of dprsRaw.results) {
    dprs[d.day_id] = {
      dayId: d.day_id, plannedEighths: d.planned_eighths, eighthsShot: d.eighths_shot, setups: d.setups,
      firstShot: d.first_shot, lunch: d.lunch, wrap: d.wrap_time,
      approved: !!d.approved, approvedBy: d.approved_by,
      done: dprScenes.results.filter((r) => r.day_id === d.day_id && r.result === "done").map((r) => r.scene_id),
      part: dprScenes.results.filter((r) => r.day_id === d.day_id && r.result === "part").map((r) => r.scene_id),
      delays: delayRows.results.filter((r) => r.day_id === d.day_id).map((r) => ({ reason: r.reason, mins: r.mins, note: r.note })),
      incidents: incidentRows.results.filter((r) => r.day_id === d.day_id).map((r) => ({ type: r.type, note: r.note, severity: r.severity })),
    };
  }

  const csRaw = await db.prepare("SELECT * FROM call_sheets WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?)").bind(productionId).all();
  const ackRows = await db.prepare("SELECT * FROM call_sheet_ack WHERE day_id IN (SELECT day_id FROM call_sheets WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?))").bind(productionId).all();
  const callSheets = {};
  for (const c of csRaw.results) {
    callSheets[c.day_id] = {
      dayId: c.day_id, version: c.version, publishedAt: c.published_at, notes: c.notes, safety: c.safety,
      ack: ackRows.results.filter((r) => r.day_id === c.day_id).map((r) => r.person_id),
    };
  }

  return {
    production: {
      title: prod.title, format: prod.format, languages: prod.languages, currency: prod.currency,
      territory: prod.territory, company: prod.company, prepStart: prod.prep_start,
      shootStart: prod.shoot_start, shootEnd: prod.shoot_end, plannedDays: prod.planned_days,
      dayLengthHours: prod.day_length_hours, minsPerEighth: prod.mins_per_eighth,
      status: prod.status, currentDayId: prod.current_day_id, dpTarget: prod.dp_target,
    },
    scenes: scenes.results.map((s) => ({
      id: s.id, no: s.no, intExt: s.int_ext, set: s.set_name, dn: s.dn, eighths: s.eighths,
      storyDay: s.story_day, locId: s.loc_id, synopsis: s.synopsis, cast: castByScene[s.id] || [],
    })),
    characters: characters.results.map((c) => ({ id: c.id, name: c.name, castId: c.cast_person_id, minor: !!c.is_minor })),
    locations: locations.results.map((l) => ({ ...l, sets: JSON.parse(l.sets || "[]"), permitExpiry: l.permit_expiry })),
    people: people.results.map((p) => ({
      id: p.id, name: p.name, type: p.type, dept: p.department, role: p.role, phone: p.phone, email: p.email,
      rate: p.rate, basis: p.rate_basis, start: p.start_date, end: p.end_date,
    })),
    elements: elements.results.map((e) => ({
      id: e.id, cat: e.category, name: e.name, dept: e.department, status: e.status,
      est: e.est_cost, actual: e.actual_cost, vendor: e.vendor, scenes: scenesByElement[e.id] || [],
    })),
    days: days.results.map((d) => ({
      id: d.id, n: d.n, date: d.date, unit: d.unit, locId: d.loc_id,
      call: d.call_time, shootCall: d.shoot_call, wrap: d.wrap_time, status: d.status,
      strips: stripsByDay[d.id] || [],
    })),
    dprs,
    callSheets,
    accounts: accounts.results.map((a) => ({
      id: a.id, code: a.code, cat: a.category, name: a.name, lines: linesByAccount[a.id] || [],
    })),
    pos: pos.results.map((p) => ({
      id: p.id, no: p.no, vendor: p.vendor, accId: p.account_id, amount: p.amount,
      status: p.status, raisedBy: p.raised_by, date: p.date, desc: p.description,
    })),
    expenses: expenses.results.map((x) => ({
      id: x.id, date: x.date, desc: x.description, accId: x.account_id, dept: x.department,
      amount: x.amount, mode: x.mode, status: x.status, by: x.submitted_by,
    })),
    audit: auditRows.results.map((a) => ({ ts: a.ts, actor: a.actor_name, action: a.action, object: a.object, detail: a.detail })),
  };
}

/* ── Actions ──────────────────────────────────────────────────────────
   Each handler: (db, productionId, member, user, payload) -> result object.
   Permission is checked first, unconditionally, before any DB write. */

export const actions = {
  async addPerson(db, pid, member, user, p) {
    requireCan(member, "edit_people");
    const id = uid("p");
    await db.prepare(
      `INSERT INTO people (id, production_id, name, type, department, role, phone, email, rate, rate_basis, start_date, end_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, pid, p.name, p.type === "cast" ? "cast" : "crew", p.dept || "", p.role || "",
      p.phone || "", p.email || "", Number(p.rate) || 0, p.basis || "day", p.start || null, p.end || null).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: `Person — ${p.name}`, detail: p.role || "" });
    return { id };
  },

  async addLocation(db, pid, member, user, p) {
    requireCan(member, "edit_locations");
    const id = uid("l");
    await db.prepare(
      `INSERT INTO locations (id, production_id, name, sets, address, lat, lng, contact, phone, rate, permit, permit_expiry, hospital, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, pid, p.name, JSON.stringify(p.sets || []), p.address || "", p.lat ?? null, p.lng ?? null,
      p.contact || "", p.phone || "", Number(p.rate) || 0, p.permit || "Scouted", p.permitExpiry || null,
      p.hospital || "", p.notes || "").run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: `Location — ${p.name}` });
    return { id };
  },

  async addAccount(db, pid, member, user, p) {
    requireCan(member, "edit_budget");
    const id = uid("a");
    await db.prepare("INSERT INTO accounts (id, production_id, code, category, name) VALUES (?,?,?,?,?)")
      .bind(id, pid, p.code, p.cat, p.name).run();
    for (const l of p.lines || []) {
      await db.prepare("INSERT INTO budget_lines (id, account_id, description, qty, unit, rate, fringe) VALUES (?,?,?,?,?,?,?)")
        .bind(uid("bl"), id, l.desc, Number(l.qty) || 1, l.unit || "flat", Number(l.rate) || 0, Number(l.fringe) || 0).run();
    }
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: `Account — ${p.code} ${p.name}` });
    return { id };
  },

  async addScene(db, pid, member, user, p) {
    requireCan(member, "edit_script");
    const id = uid("s");
    const maxOrder = await db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM scenes WHERE production_id = ?").bind(pid).first();
    await db.prepare(
      `INSERT INTO scenes (id, production_id, no, int_ext, set_name, dn, eighths, story_day, loc_id, synopsis, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, pid, p.no, p.intExt, p.set, p.dn, Number(p.eighths) || 1, Number(p.storyDay) || 1,
      p.locId || null, p.synopsis || "", (maxOrder.m || 0) + 1).run();
    for (const chId of p.cast || []) {
      await db.prepare("INSERT INTO scene_cast (scene_id, character_id) VALUES (?,?)").bind(id, chId).run();
    }
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: `Scene ${p.no}`, detail: `${p.intExt}. ${p.set}` });
    return { id };
  },

  async tagElement(db, pid, member, user, p) {
    requireCan(member, "edit_breakdown");
    let elId = p.existingId;
    if (!elId) {
      elId = uid("e");
      await db.prepare(
        `INSERT INTO elements (id, production_id, category, name, department, status, est_cost, actual_cost, vendor)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(elId, pid, p.cat, p.name, p.dept || "", "To source", 0, 0, "").run();
    }
    const already = await db.prepare("SELECT 1 FROM element_scenes WHERE element_id = ? AND scene_id = ?").bind(elId, p.sceneId).first();
    if (!already) await db.prepare("INSERT INTO element_scenes (element_id, scene_id) VALUES (?,?)").bind(elId, p.sceneId).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Tagged", object: `${p.cat} — ${p.name}`, detail: `Scene ${p.sceneNo || ""}` });
    return { id: elId };
  },

  async setElementStatus(db, pid, member, user, p) {
    requireCan(member, "edit_breakdown");
    await db.prepare("UPDATE elements SET status = ? WHERE id = ? AND production_id = ?").bind(p.status, p.elementId, pid).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Updated", object: "Element status", detail: p.status });
    return { ok: true };
  },

  async addDay(db, pid, member, user, p) {
    requireCan(member, "edit_schedule");
    const id = uid("d");
    const max = await db.prepare("SELECT COALESCE(MAX(n),0) m FROM shooting_days WHERE production_id = ?").bind(pid).first();
    const n = (max.m || 0) + 1;
    await db.prepare(
      `INSERT INTO shooting_days (id, production_id, n, date, unit, loc_id, call_time, shoot_call, wrap_time, status)
       VALUES (?,?,?,?,?,?,?,?,?,'Planned')`
    ).bind(id, pid, n, p.date, p.unit || "Main", p.locId || null, p.call || "06:00", p.shootCall || "07:00", p.wrap || "19:00").run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: "Shooting day", detail: `Day ${n}` });
    return { id, n };
  },

  // The stripboard's core invariant — a scene lives on one day, or none —
  // is enforced by the UNIQUE(scene_id) constraint on day_strips. This
  // handler just removes any existing placement first, so re-inserting is
  // always safe rather than racing the constraint.
  async moveScene(db, pid, member, user, p) {
    requireCan(member, "edit_schedule");
    await db.prepare(
      `DELETE FROM day_strips WHERE scene_id = ? AND day_id IN (SELECT id FROM shooting_days WHERE production_id = ?)`
    ).bind(p.sceneId, pid).run();
    if (p.toDayId) {
      const max = await db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM day_strips WHERE day_id = ?").bind(p.toDayId).first();
      await db.prepare("INSERT INTO day_strips (day_id, scene_id, sort_order) VALUES (?,?,?)")
        .bind(p.toDayId, p.sceneId, (max.m || 0) + 1).run();
    }
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Moved", object: `Scene ${p.sceneNo || p.sceneId}`, detail: p.toDayId ? `To day ${p.toDayN}` : "Off the board" });
    return { ok: true };
  },

  async publishCallSheet(db, pid, member, user, p) {
    requireCan(member, "publish_callsheet");
    const existing = await db.prepare("SELECT version FROM call_sheets WHERE day_id = ?").bind(p.dayId).first();
    const version = (existing?.version || 0) + 1;
    await db.prepare(
      `INSERT INTO call_sheets (day_id, version, published_at, published_by, notes, safety)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(day_id) DO UPDATE SET version=excluded.version, published_at=excluded.published_at,
         published_by=excluded.published_by, notes=excluded.notes, safety=excluded.safety`
    ).bind(p.dayId, version, nowISO(), user.id, p.notes || "", p.safety || "").run();
    // Re-issuing resets read receipts — a stale ack against Rev 1 should
    // not silently count as read against Rev 2.
    await db.prepare("DELETE FROM call_sheet_ack WHERE day_id = ?").bind(p.dayId).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Published", object: `Call sheet — Day ${p.dayN} (Rev ${version})` });
    return { version };
  },

  async ackCallSheet(db, pid, member, user, p) {
    // Any signed-in member of the production can acknowledge — this is a
    // read receipt, not a privileged write.
    await db.prepare("INSERT OR IGNORE INTO call_sheet_ack (day_id, person_id) VALUES (?,?)").bind(p.dayId, p.personId).run();
    return { ok: true };
  },

  async saveDPR(db, pid, member, user, p) {
    requireCan(member, "submit_dpr");
    const existing = await db.prepare("SELECT approved FROM dprs WHERE day_id = ?").bind(p.dayId).first();
    if (existing?.approved) {
      const err = new Error("This report is approved and locked. Corrections are issued as a revision, not an edit.");
      err.status = 409;
      throw err;
    }
    await db.prepare(
      `INSERT INTO dprs (day_id, planned_eighths, eighths_shot, setups, first_shot, lunch, wrap_time, approved)
       VALUES (?,?,?,?,?,?,?,0)
       ON CONFLICT(day_id) DO UPDATE SET planned_eighths=excluded.planned_eighths, eighths_shot=excluded.eighths_shot,
         setups=excluded.setups, first_shot=excluded.first_shot, lunch=excluded.lunch, wrap_time=excluded.wrap_time`
    ).bind(p.dayId, p.plannedEighths, p.eighthsShot, p.setups || 0, p.firstShot || "", p.lunch || "", p.wrap || "").run();

    await db.prepare("DELETE FROM dpr_scenes WHERE day_id = ?").bind(p.dayId).run();
    for (const sceneId of p.done || []) await db.prepare("INSERT INTO dpr_scenes (day_id, scene_id, result) VALUES (?,?,'done')").bind(p.dayId, sceneId).run();
    for (const sceneId of p.part || []) await db.prepare("INSERT INTO dpr_scenes (day_id, scene_id, result) VALUES (?,?,'part')").bind(p.dayId, sceneId).run();

    await db.prepare("DELETE FROM delays WHERE day_id = ?").bind(p.dayId).run();
    for (const d of p.delays || []) await db.prepare("INSERT INTO delays (id, day_id, reason, mins, note) VALUES (?,?,?,?,?)")
      .bind(uid("dl"), p.dayId, d.reason, d.mins, d.note || "").run();

    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Saved", object: `DPR — Day ${p.dayN}`, detail: "Draft" });
    return { ok: true };
  },

  // The approval gate: locks the report, carries part-shot scenes back to
  // the unscheduled pool, and advances the current shooting day. This is
  // the server-side twin of the DPRModule.save(true) handler in the SPA.
  async approveDPR(db, pid, member, user, p) {
    requireCan(member, "approve_dpr");
    await db.prepare("UPDATE dprs SET approved = 1, approved_by = ?, approved_at = ? WHERE day_id = ?")
      .bind(user.id, nowISO(), p.dayId).run();
    await db.prepare("UPDATE shooting_days SET status = 'Completed' WHERE id = ?").bind(p.dayId).run();

    const partScenes = await db.prepare("SELECT scene_id FROM dpr_scenes WHERE day_id = ? AND result = 'part'").bind(p.dayId).all();
    for (const row of partScenes.results) {
      await db.prepare("DELETE FROM day_strips WHERE day_id = ? AND scene_id = ?").bind(p.dayId, row.scene_id).run();
    }

    const day = await db.prepare("SELECT n FROM shooting_days WHERE id = ?").bind(p.dayId).first();
    const next = await db.prepare("SELECT id FROM shooting_days WHERE production_id = ? AND n = ?").bind(pid, day.n + 1).first();
    if (next) {
      await db.prepare("UPDATE productions SET current_day_id = ? WHERE id = ?").bind(next.id, pid).run();
      await db.prepare("UPDATE shooting_days SET status = 'Shooting' WHERE id = ?").bind(next.id).run();
    }

    await audit(db, pid, {
      actorId: user.id, actorName: user.name, action: "Approved", object: `DPR — Day ${day.n}`,
      detail: `${partScenes.results.length} scene(s) carried to the board` + (next ? "" : " · final day"),
    });
    return { ok: true, carried: partScenes.results.length };
  },

  async raisePO(db, pid, member, user, p) {
    requireCan(member, "raise_po");
    const id = uid("po");
    const count = await db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE production_id = ?").bind(pid).first();
    const no = `PO-${String(count.c + 1).padStart(4, "0")}`;
    await db.prepare(
      `INSERT INTO purchase_orders (id, production_id, no, vendor, account_id, amount, status, raised_by, date, description)
       VALUES (?,?,?,?,?,?,'Submitted',?,?,?)`
    ).bind(id, pid, no, p.vendor, p.accId, Number(p.amount) || 0, user.id, p.date, p.desc || "").run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Raised", object: `${no} — ${p.vendor}`, detail: `₹${Number(p.amount) || 0}` });
    return { id, no };
  },

  // Approving a PO commits budget the moment it happens (FR-FIN-011). If
  // the amount exceeds what's left on the account, the normal approval
  // tier is blocked — only a producer (approve_po_over_budget) can push it
  // through, and the override is recorded. This is AC-3 from the spec,
  // now a real, server-enforced rule instead of a UI confirmation dialog.
  async decidePO(db, pid, member, user, p) {
    requireCan(member, "approve_po");
    const po = await db.prepare("SELECT * FROM purchase_orders WHERE id = ? AND production_id = ?").bind(p.poId, pid).first();
    if (!po) { const e = new Error("Purchase order not found."); e.status = 404; throw e; }

    if (p.status === "Approved") {
      const fin = await accountFinancials(db, po.account_id);
      if (po.amount > fin.available) {
        requireCan(member, "approve_po_over_budget");
      }
    }

    await db.prepare("UPDATE purchase_orders SET status = ?, approved_by = ? WHERE id = ?")
      .bind(p.status, p.status === "Approved" ? user.id : null, p.poId).run();
    await audit(db, pid, {
      actorId: user.id, actorName: user.name, action: p.status, object: `${po.no} — ${po.vendor}`,
      detail: `₹${po.amount}${member.role === "producer" && p.status === "Approved" ? " · approved at producer tier" : ""}`,
    });
    return { ok: true };
  },

  async submitExpense(db, pid, member, user, p) {
    requireCan(member, "submit_expense");
    const id = uid("x");
    await db.prepare(
      `INSERT INTO expenses (id, production_id, date, description, account_id, department, amount, mode, status, submitted_by)
       VALUES (?,?,?,?,?,?,?,?,'Submitted',?)`
    ).bind(id, pid, p.date, p.desc, p.accId, p.dept || "", Number(p.amount) || 0, p.mode || "Petty cash", user.id).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Submitted", object: `Expense — ${p.desc}`, detail: `₹${Number(p.amount) || 0}` });
    return { id };
  },

  async decideExpense(db, pid, member, user, p) {
    requireCan(member, "approve_expense");
    const x = await db.prepare("SELECT * FROM expenses WHERE id = ? AND production_id = ?").bind(p.expenseId, pid).first();
    if (!x) { const e = new Error("Expense not found."); e.status = 404; throw e; }
    await db.prepare("UPDATE expenses SET status = ?, approved_by = ? WHERE id = ?")
      .bind(p.status, p.status === "Approved" ? user.id : null, p.expenseId).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: p.status, object: `Expense — ${x.description}`, detail: `₹${x.amount}` });
    return { ok: true };
  },
  async editScene(db, pid, member, user, p) {
    requireCan(member, "edit_script");
    await db.prepare(
      `UPDATE scenes SET no=?, int_ext=?, set_name=?, dn=?, eighths=?, story_day=?, loc_id=?, synopsis=?
       WHERE id = ? AND production_id = ?`
    ).bind(p.no, p.intExt, p.set, p.dn, Number(p.eighths) || 1, Number(p.storyDay) || 1, p.locId || null, p.synopsis || "", p.sceneId, pid).run();
    await db.prepare("DELETE FROM scene_cast WHERE scene_id = ?").bind(p.sceneId).run();
    for (const chId of p.cast || []) {
      await db.prepare("INSERT INTO scene_cast (scene_id, character_id) VALUES (?,?)").bind(p.sceneId, chId).run();
    }
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Edited", object: `Scene ${p.no}`, detail: `${p.intExt}. ${p.set} — ${p.dn}` });
    return { ok: true };
  },

  async untagElement(db, pid, member, user, p) {
    requireCan(member, "edit_breakdown");
    await db.prepare("DELETE FROM element_scenes WHERE element_id = ? AND scene_id = ?").bind(p.elementId, p.sceneId).run();
    const remaining = await db.prepare("SELECT COUNT(*) c FROM element_scenes WHERE element_id = ?").bind(p.elementId).first();
    if (remaining.c === 0) await db.prepare("DELETE FROM elements WHERE id = ?").bind(p.elementId).run();
    return { ok: true, removed: remaining.c === 0 };
  },

  async updateDay(db, pid, member, user, p) {
    requireCan(member, "edit_schedule");
    const sets = [], vals = [];
    if (p.locId !== undefined) { sets.push("loc_id = ?"); vals.push(p.locId); }
    if (p.call !== undefined) { sets.push("call_time = ?"); vals.push(p.call); }
    if (p.shootCall !== undefined) { sets.push("shoot_call = ?"); vals.push(p.shootCall); }
    if (p.wrap !== undefined) { sets.push("wrap_time = ?"); vals.push(p.wrap); }
    if (!sets.length) return { ok: true };
    vals.push(p.dayId, pid);
    await db.prepare(`UPDATE shooting_days SET ${sets.join(", ")} WHERE id = ? AND production_id = ?`).bind(...vals).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Changed", object: `Day ${p.dayN} settings`, detail: p.detail || "" });
    return { ok: true };
  },

  async updateLocationPermit(db, pid, member, user, p) {
    requireCan(member, "edit_locations");
    await db.prepare("UPDATE locations SET permit = ? WHERE id = ? AND production_id = ?").bind(p.permit, p.locId, pid).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Updated", object: "Location permit", detail: p.permit });
    return { ok: true };
  },
  // Bulk import: parsed scenes carry castNames (strings), not character ids
  // yet — new names become new characters, known names are matched by
  // name. Replace mode clears the board (scheduling a script that no
  // longer exists would be meaningless); append mode just adds after.
  async importScript(db, pid, member, user, p) {
    requireCan(member, "edit_script");
    const existingChars = await db.prepare("SELECT id, name FROM characters WHERE production_id = ?").bind(pid).all();
    const nameToId = {};
    for (const c of existingChars.results) nameToId[c.name] = c.id;

    if (p.mode === "replace") {
      await db.prepare(`DELETE FROM day_strips WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?)`).bind(pid).run();
      await db.prepare(`DELETE FROM scenes WHERE production_id = ?`).bind(pid).run();
    }
    const startNo = p.mode === "append"
      ? (await db.prepare("SELECT COUNT(*) c FROM scenes WHERE production_id = ?").bind(pid).first()).c
      : 0;
    const maxOrder = (await db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM scenes WHERE production_id = ?").bind(pid).first()).m || 0;

    let i = 0;
    for (const s of p.scenes || []) {
      for (const nm of s.castNames || []) {
        if (!nameToId[nm]) {
          const chId = uid("ch");
          await db.prepare("INSERT INTO characters (id, production_id, name) VALUES (?,?,?)").bind(chId, pid, nm).run();
          nameToId[nm] = chId;
        }
      }
      const sceneId = uid("s");
      const no = p.mode === "append" ? String(startNo + i + 1) : s.no;
      await db.prepare(
        `INSERT INTO scenes (id, production_id, no, int_ext, set_name, dn, eighths, story_day, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(sceneId, pid, no, s.intExt, s.set, s.dn, s.eighths || 1, s.storyDay || 1, maxOrder + i + 1).run();
      for (const nm of s.castNames || []) {
        await db.prepare("INSERT INTO scene_cast (scene_id, character_id) VALUES (?,?)").bind(sceneId, nameToId[nm]).run();
      }
      i++;
    }

    await audit(db, pid, {
      actorId: user.id, actorName: user.name, action: "Imported", object: "Script",
      detail: `${(p.scenes || []).length} scenes parsed · ${p.mode === "replace" ? "replaced existing" : "appended"}`,
    });
    return { count: (p.scenes || []).length };
  },
  async ackAllCallSheet(db, pid, member, user, p) {
    // A blunt "mark everyone read" tool for the AD chasing stragglers.
    // Anyone who can publish can also do this — it's a distribution aid,
    // not a privileged financial or scheduling action.
    requireCan(member, "publish_callsheet");
    const people = await db.prepare("SELECT id FROM people WHERE production_id = ?").bind(pid).all();
    for (const person of people.results) {
      await db.prepare("INSERT OR IGNORE INTO call_sheet_ack (day_id, person_id) VALUES (?,?)").bind(p.dayId, person.id).run();
    }
    return { ok: true, count: people.results.length };
  },
};

export { accountFinancials };
