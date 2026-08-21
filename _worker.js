// functions/api/lib/auth.js
var enc = new TextEncoder();
var toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
var fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
var DEFAULT_ITERATIONS = 1e4;
var iterationsFor = (env) => {
  const n = parseInt(env?.PBKDF2_ITERATIONS, 10);
  return Number.isFinite(n) && n >= 1e3 ? n : DEFAULT_ITERATIONS;
};
async function hashPassword(password, env) {
  const iterations = iterationsFor(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return { hash: toHex(bits), salt: `${iterations}$${toHex(salt)}` };
}
async function verifyPassword(password, hash, storedSalt) {
  let iterations = DEFAULT_ITERATIONS, saltHex = storedSalt;
  if (typeof storedSalt === "string" && storedSalt.includes("$")) {
    const [n, rest] = storedSalt.split("$");
    const parsed = parseInt(n, 10);
    if (Number.isFinite(parsed)) iterations = parsed;
    saltHex = rest;
  }
  if (!/^[0-9a-f]+$/i.test(saltHex || "")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations, hash: "SHA-256" },
    key,
    256
  );
  const computed = toHex(bits);
  if (computed.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
function newSessionToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
var SESSION_DAYS = 14;
function parseCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionCookie(token, maxAgeSeconds) {
  return `fpms_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
var clearSessionCookie = () => "fpms_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

// functions/api/lib/db.js
async function assertMember(db, productionId, userId) {
  const row = await db.prepare("SELECT role, department FROM production_members WHERE production_id = ? AND user_id = ?").bind(productionId, userId).first();
  return row || null;
}
var uid = (prefix = "id") => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
var nowISO = () => (/* @__PURE__ */ new Date()).toISOString();
async function audit(db, productionId, { actorId, actorName, action, object, detail }) {
  await db.prepare("INSERT INTO audit_log (id, production_id, actor_id, actor_name, action, object, detail) VALUES (?,?,?,?,?,?,?)").bind(uid("aud"), productionId, actorId || null, actorName, action, object, detail || "").run();
}
var json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders }
});
var errors = {
  unauthenticated: () => json({ error: "Not signed in." }, 401),
  forbidden: (msg) => json({ error: msg || "You don't have permission to do that." }, 403),
  notFound: (what) => json({ error: `${what} not found.` }, 404),
  badRequest: (msg) => json({ error: msg }, 400)
};

// functions/api/auth/signup.js
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function onRequestPost({ request, env }) {
  if (!env.DB) return errors.badRequest("Database is not bound. See README \u2014 D1 setup.");
  let body;
  try {
    body = await request.json();
  } catch {
    return errors.badRequest("Body must be JSON.");
  }
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
    ).bind(userId, wsId, email.toLowerCase(), name.trim(), hash, salt)
  ]);
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)").bind(token, userId, expires).run();
  return json(
    { user: { id: userId, name: name.trim(), email: email.toLowerCase() }, workspace: { id: wsId, name: workspaceName.trim() } },
    201,
    { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) }
  );
}

// functions/api/auth/signin.js
async function onRequestPost2({ request, env }) {
  if (!env.DB) return errors.badRequest("Database is not bound. See README \u2014 D1 setup.");
  let body;
  try {
    body = await request.json();
  } catch {
    return errors.badRequest("Body must be JSON.");
  }
  const { email, password } = body || {};
  if (!email || !password) return errors.badRequest("Email and password are required.");
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first();
  if (!user || !await verifyPassword(password, user.password_hash, user.password_salt)) {
    return errors.badRequest("Incorrect email or password.");
  }
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)").bind(token, user.id, expires).run();
  return json(
    { user: { id: user.id, name: user.name, email: user.email } },
    200,
    { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) }
  );
}

// functions/api/auth/signout.js
async function onRequestPost3({ request, env }) {
  const token = parseCookie(request.headers.get("Cookie"), "fpms_session");
  if (token && env.DB) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

// functions/api/lib/session.js
async function withUser(context) {
  const { request, env } = context;
  if (!env.DB) return { ...context, user: null };
  const token = parseCookie(request.headers.get("Cookie"), "fpms_session");
  if (!token) return { ...context, user: null };
  const row = await env.DB.prepare(
    `SELECT u.id, u.workspace_id, u.name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
  return { ...context, user: row || null };
}

// functions/api/auth/me.js
async function onRequestGet(context) {
  const { user } = await withUser(context);
  return json({ user: user || null });
}

// functions/api/productions/index.js
async function onRequestGet2(context) {
  const { env, user } = await withUser(context);
  if (!user) return errors.unauthenticated();
  const rows = await env.DB.prepare(
    `SELECT p.id, p.title, p.status, p.planned_days, m.role
     FROM productions p JOIN production_members m ON m.production_id = p.id
     WHERE m.user_id = ? ORDER BY p.created_at DESC`
  ).bind(user.id).all();
  return json({ productions: rows.results });
}
async function onRequestPost4(context) {
  const { request, env, user } = await withUser(context);
  if (!user) return errors.unauthenticated();
  let body;
  try {
    body = await request.json();
  } catch {
    return errors.badRequest("Body must be JSON.");
  }
  if (!body?.title?.trim()) return errors.badRequest("A production title is required.");
  const id = uid("prod");
  await env.DB.prepare(
    `INSERT INTO productions (id, workspace_id, title, format, currency, territory, company, planned_days, status)
     VALUES (?,?,?,?,?,?,?,?, 'Prep')`
  ).bind(
    id,
    body.workspaceId || (await env.DB.prepare("SELECT workspace_id FROM users WHERE id = ?").bind(user.id).first()).workspace_id,
    body.title.trim(),
    body.format || "Feature",
    body.currency || "INR",
    body.territory || "",
    body.company || "",
    Number(body.plannedDays) || 0
  ).run();
  await env.DB.prepare("INSERT INTO production_members (production_id, user_id, role) VALUES (?,?,'producer')").bind(id, user.id).run();
  return json({ id }, 201);
}

// functions/api/lib/permissions.js
var CAN = {
  // financial data — FR-ROLE-004: invisible by default except these roles
  view_rates: { producer: true, line_producer: true, accountant: true },
  view_budget: { producer: true, line_producer: true, accountant: true, dept_head: "own-department" },
  edit_budget: { producer: true, line_producer: true, accountant: true },
  raise_po: { producer: true, line_producer: true, accountant: true, dept_head: true },
  approve_po: { producer: true, line_producer: true, accountant: true },
  approve_po_over_budget: { producer: true },
  // escalation tier — §9.4 AC-3
  submit_expense: { producer: true, line_producer: true, accountant: true, dept_head: true, second_ad: true },
  approve_expense: { producer: true, line_producer: true, accountant: true },
  // schedule & script
  edit_script: { producer: true, line_producer: true, first_ad: true, director: true },
  edit_breakdown: { producer: true, line_producer: true, first_ad: true, dept_head: true },
  edit_schedule: { producer: true, line_producer: true, first_ad: true },
  publish_callsheet: { producer: true, line_producer: true, first_ad: true, second_ad: true },
  submit_dpr: { producer: true, line_producer: true, first_ad: true, second_ad: true },
  approve_dpr: { producer: true, line_producer: true },
  // people & locations
  edit_people: { producer: true, line_producer: true, first_ad: true },
  view_pii: { producer: true, line_producer: true, accountant: true },
  edit_locations: { producer: true, line_producer: true, first_ad: true, dept_head: true },
  // production settings
  manage_members: { producer: true },
  edit_production: { producer: true, line_producer: true }
};
function can(member, capability, ctx = {}) {
  if (!member) return false;
  const rule = CAN[capability]?.[member.role];
  if (rule === true) return true;
  if (rule === "own-department") return !!ctx.department && ctx.department === member.department;
  return false;
}
function requireCan(member, capability, ctx) {
  if (!can(member, capability, ctx)) {
    const err = new Error(`Role "${member?.role || "none"}" cannot ${capability.replace(/_/g, " ")}.`);
    err.status = 403;
    throw err;
  }
}

// functions/api/lib/actions.js
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
async function assembleState(db, productionId) {
  const prod = await db.prepare("SELECT * FROM productions WHERE id = ?").bind(productionId).first();
  if (!prod) return null;
  const [
    scenes,
    sceneCast,
    characters,
    locations,
    people,
    elements,
    elementScenes,
    days,
    strips,
    accounts,
    lines,
    pos,
    expenses,
    auditRows
  ] = await Promise.all([
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
    db.prepare("SELECT * FROM audit_log WHERE production_id = ? ORDER BY ts DESC LIMIT 200").bind(productionId).all()
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
      dayId: d.day_id,
      plannedEighths: d.planned_eighths,
      eighthsShot: d.eighths_shot,
      setups: d.setups,
      firstShot: d.first_shot,
      lunch: d.lunch,
      wrap: d.wrap_time,
      approved: !!d.approved,
      approvedBy: d.approved_by,
      done: dprScenes.results.filter((r) => r.day_id === d.day_id && r.result === "done").map((r) => r.scene_id),
      part: dprScenes.results.filter((r) => r.day_id === d.day_id && r.result === "part").map((r) => r.scene_id),
      delays: delayRows.results.filter((r) => r.day_id === d.day_id).map((r) => ({ reason: r.reason, mins: r.mins, note: r.note })),
      incidents: incidentRows.results.filter((r) => r.day_id === d.day_id).map((r) => ({ type: r.type, note: r.note, severity: r.severity }))
    };
  }
  const csRaw = await db.prepare("SELECT * FROM call_sheets WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?)").bind(productionId).all();
  const ackRows = await db.prepare("SELECT * FROM call_sheet_ack WHERE day_id IN (SELECT day_id FROM call_sheets WHERE day_id IN (SELECT id FROM shooting_days WHERE production_id = ?))").bind(productionId).all();
  const callSheets = {};
  for (const c of csRaw.results) {
    callSheets[c.day_id] = {
      dayId: c.day_id,
      version: c.version,
      publishedAt: c.published_at,
      notes: c.notes,
      safety: c.safety,
      ack: ackRows.results.filter((r) => r.day_id === c.day_id).map((r) => r.person_id)
    };
  }
  return {
    production: {
      title: prod.title,
      format: prod.format,
      languages: prod.languages,
      currency: prod.currency,
      territory: prod.territory,
      company: prod.company,
      prepStart: prod.prep_start,
      shootStart: prod.shoot_start,
      shootEnd: prod.shoot_end,
      plannedDays: prod.planned_days,
      dayLengthHours: prod.day_length_hours,
      minsPerEighth: prod.mins_per_eighth,
      status: prod.status,
      currentDayId: prod.current_day_id,
      dpTarget: prod.dp_target
    },
    scenes: scenes.results.map((s) => ({
      id: s.id,
      no: s.no,
      intExt: s.int_ext,
      set: s.set_name,
      dn: s.dn,
      eighths: s.eighths,
      storyDay: s.story_day,
      locId: s.loc_id,
      synopsis: s.synopsis,
      cast: castByScene[s.id] || []
    })),
    characters: characters.results.map((c) => ({ id: c.id, name: c.name, castId: c.cast_person_id, minor: !!c.is_minor })),
    locations: locations.results.map((l) => ({ ...l, sets: JSON.parse(l.sets || "[]"), permitExpiry: l.permit_expiry })),
    people: people.results.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      dept: p.department,
      role: p.role,
      phone: p.phone,
      email: p.email,
      rate: p.rate,
      basis: p.rate_basis,
      start: p.start_date,
      end: p.end_date
    })),
    elements: elements.results.map((e) => ({
      id: e.id,
      cat: e.category,
      name: e.name,
      dept: e.department,
      status: e.status,
      est: e.est_cost,
      actual: e.actual_cost,
      vendor: e.vendor,
      scenes: scenesByElement[e.id] || []
    })),
    days: days.results.map((d) => ({
      id: d.id,
      n: d.n,
      date: d.date,
      unit: d.unit,
      locId: d.loc_id,
      call: d.call_time,
      shootCall: d.shoot_call,
      wrap: d.wrap_time,
      status: d.status,
      strips: stripsByDay[d.id] || []
    })),
    dprs,
    callSheets,
    accounts: accounts.results.map((a) => ({
      id: a.id,
      code: a.code,
      cat: a.category,
      name: a.name,
      lines: linesByAccount[a.id] || []
    })),
    pos: pos.results.map((p) => ({
      id: p.id,
      no: p.no,
      vendor: p.vendor,
      accId: p.account_id,
      amount: p.amount,
      status: p.status,
      raisedBy: p.raised_by,
      date: p.date,
      desc: p.description
    })),
    expenses: expenses.results.map((x) => ({
      id: x.id,
      date: x.date,
      desc: x.description,
      accId: x.account_id,
      dept: x.department,
      amount: x.amount,
      mode: x.mode,
      status: x.status,
      by: x.submitted_by
    })),
    audit: auditRows.results.map((a) => ({ ts: a.ts, actor: a.actor_name, action: a.action, object: a.object, detail: a.detail }))
  };
}
var actions = {
  async addPerson(db, pid, member, user, p) {
    requireCan(member, "edit_people");
    const id = uid("p");
    await db.prepare(
      `INSERT INTO people (id, production_id, name, type, department, role, phone, email, rate, rate_basis, start_date, end_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id,
      pid,
      p.name,
      p.type === "cast" ? "cast" : "crew",
      p.dept || "",
      p.role || "",
      p.phone || "",
      p.email || "",
      Number(p.rate) || 0,
      p.basis || "day",
      p.start || null,
      p.end || null
    ).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: `Person \u2014 ${p.name}`, detail: p.role || "" });
    return { id };
  },
  async addLocation(db, pid, member, user, p) {
    requireCan(member, "edit_locations");
    const id = uid("l");
    await db.prepare(
      `INSERT INTO locations (id, production_id, name, sets, address, lat, lng, contact, phone, rate, permit, permit_expiry, hospital, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id,
      pid,
      p.name,
      JSON.stringify(p.sets || []),
      p.address || "",
      p.lat ?? null,
      p.lng ?? null,
      p.contact || "",
      p.phone || "",
      Number(p.rate) || 0,
      p.permit || "Scouted",
      p.permitExpiry || null,
      p.hospital || "",
      p.notes || ""
    ).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: `Location \u2014 ${p.name}` });
    return { id };
  },
  async addAccount(db, pid, member, user, p) {
    requireCan(member, "edit_budget");
    const id = uid("a");
    await db.prepare("INSERT INTO accounts (id, production_id, code, category, name) VALUES (?,?,?,?,?)").bind(id, pid, p.code, p.cat, p.name).run();
    for (const l of p.lines || []) {
      await db.prepare("INSERT INTO budget_lines (id, account_id, description, qty, unit, rate, fringe) VALUES (?,?,?,?,?,?,?)").bind(uid("bl"), id, l.desc, Number(l.qty) || 1, l.unit || "flat", Number(l.rate) || 0, Number(l.fringe) || 0).run();
    }
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Added", object: `Account \u2014 ${p.code} ${p.name}` });
    return { id };
  },
  async addScene(db, pid, member, user, p) {
    requireCan(member, "edit_script");
    const id = uid("s");
    const maxOrder = await db.prepare("SELECT COALESCE(MAX(sort_order),0) m FROM scenes WHERE production_id = ?").bind(pid).first();
    await db.prepare(
      `INSERT INTO scenes (id, production_id, no, int_ext, set_name, dn, eighths, story_day, loc_id, synopsis, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id,
      pid,
      p.no,
      p.intExt,
      p.set,
      p.dn,
      Number(p.eighths) || 1,
      Number(p.storyDay) || 1,
      p.locId || null,
      p.synopsis || "",
      (maxOrder.m || 0) + 1
    ).run();
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
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Tagged", object: `${p.cat} \u2014 ${p.name}`, detail: `Scene ${p.sceneNo || ""}` });
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
      await db.prepare("INSERT INTO day_strips (day_id, scene_id, sort_order) VALUES (?,?,?)").bind(p.toDayId, p.sceneId, (max.m || 0) + 1).run();
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
    await db.prepare("DELETE FROM call_sheet_ack WHERE day_id = ?").bind(p.dayId).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Published", object: `Call sheet \u2014 Day ${p.dayN} (Rev ${version})` });
    return { version };
  },
  async ackCallSheet(db, pid, member, user, p) {
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
    for (const d of p.delays || []) await db.prepare("INSERT INTO delays (id, day_id, reason, mins, note) VALUES (?,?,?,?,?)").bind(uid("dl"), p.dayId, d.reason, d.mins, d.note || "").run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Saved", object: `DPR \u2014 Day ${p.dayN}`, detail: "Draft" });
    return { ok: true };
  },
  // The approval gate: locks the report, carries part-shot scenes back to
  // the unscheduled pool, and advances the current shooting day. This is
  // the server-side twin of the DPRModule.save(true) handler in the SPA.
  async approveDPR(db, pid, member, user, p) {
    requireCan(member, "approve_dpr");
    await db.prepare("UPDATE dprs SET approved = 1, approved_by = ?, approved_at = ? WHERE day_id = ?").bind(user.id, nowISO(), p.dayId).run();
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
      actorId: user.id,
      actorName: user.name,
      action: "Approved",
      object: `DPR \u2014 Day ${day.n}`,
      detail: `${partScenes.results.length} scene(s) carried to the board` + (next ? "" : " \xB7 final day")
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
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Raised", object: `${no} \u2014 ${p.vendor}`, detail: `\u20B9${Number(p.amount) || 0}` });
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
    if (!po) {
      const e = new Error("Purchase order not found.");
      e.status = 404;
      throw e;
    }
    if (p.status === "Approved") {
      const fin = await accountFinancials(db, po.account_id);
      if (po.amount > fin.available) {
        requireCan(member, "approve_po_over_budget");
      }
    }
    await db.prepare("UPDATE purchase_orders SET status = ?, approved_by = ? WHERE id = ?").bind(p.status, p.status === "Approved" ? user.id : null, p.poId).run();
    await audit(db, pid, {
      actorId: user.id,
      actorName: user.name,
      action: p.status,
      object: `${po.no} \u2014 ${po.vendor}`,
      detail: `\u20B9${po.amount}${member.role === "producer" && p.status === "Approved" ? " \xB7 approved at producer tier" : ""}`
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
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Submitted", object: `Expense \u2014 ${p.desc}`, detail: `\u20B9${Number(p.amount) || 0}` });
    return { id };
  },
  async decideExpense(db, pid, member, user, p) {
    requireCan(member, "approve_expense");
    const x = await db.prepare("SELECT * FROM expenses WHERE id = ? AND production_id = ?").bind(p.expenseId, pid).first();
    if (!x) {
      const e = new Error("Expense not found.");
      e.status = 404;
      throw e;
    }
    await db.prepare("UPDATE expenses SET status = ?, approved_by = ? WHERE id = ?").bind(p.status, p.status === "Approved" ? user.id : null, p.expenseId).run();
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: p.status, object: `Expense \u2014 ${x.description}`, detail: `\u20B9${x.amount}` });
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
    await audit(db, pid, { actorId: user.id, actorName: user.name, action: "Edited", object: `Scene ${p.no}`, detail: `${p.intExt}. ${p.set} \u2014 ${p.dn}` });
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
    if (p.locId !== void 0) {
      sets.push("loc_id = ?");
      vals.push(p.locId);
    }
    if (p.call !== void 0) {
      sets.push("call_time = ?");
      vals.push(p.call);
    }
    if (p.shootCall !== void 0) {
      sets.push("shoot_call = ?");
      vals.push(p.shootCall);
    }
    if (p.wrap !== void 0) {
      sets.push("wrap_time = ?");
      vals.push(p.wrap);
    }
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
    const startNo = p.mode === "append" ? (await db.prepare("SELECT COUNT(*) c FROM scenes WHERE production_id = ?").bind(pid).first()).c : 0;
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
      actorId: user.id,
      actorName: user.name,
      action: "Imported",
      object: "Script",
      detail: `${(p.scenes || []).length} scenes parsed \xB7 ${p.mode === "replace" ? "replaced existing" : "appended"}`
    });
    return { count: (p.scenes || []).length };
  },
  async ackAllCallSheet(db, pid, member, user, p) {
    requireCan(member, "publish_callsheet");
    const people = await db.prepare("SELECT id FROM people WHERE production_id = ?").bind(pid).all();
    for (const person of people.results) {
      await db.prepare("INSERT OR IGNORE INTO call_sheet_ack (day_id, person_id) VALUES (?,?)").bind(p.dayId, person.id).run();
    }
    return { ok: true, count: people.results.length };
  }
};

// functions/api/productions/[id]/state.js
async function onRequestGet3(context) {
  const { env, user, params } = await withUser(context);
  if (!user) return errors.unauthenticated();
  const member = await assertMember(env.DB, params.id, user.id);
  if (!member) return errors.forbidden("You are not a member of this production.");
  const state = await assembleState(env.DB, params.id);
  if (!state) return errors.notFound("Production");
  const canSeeRates = ["producer", "line_producer", "accountant"].includes(member.role);
  if (!canSeeRates) {
    state.people = state.people.map((p) => ({ ...p, rate: null }));
    state.accounts = state.accounts.map((a) => ({ ...a, lines: a.lines.map((l) => ({ ...l, rate: null })) }));
  }
  return json({ state, member: { role: member.role, department: member.department } });
}

// functions/api/productions/[id]/actions.js
async function onRequestPost5(context) {
  const { request, env, user, params } = await withUser(context);
  if (!user) return errors.unauthenticated();
  const member = await assertMember(env.DB, params.id, user.id);
  if (!member) return errors.forbidden("You are not a member of this production.");
  let body;
  try {
    body = await request.json();
  } catch {
    return errors.badRequest("Body must be JSON.");
  }
  const { type, payload } = body || {};
  const handler = actions[type];
  if (!handler) return errors.badRequest(`Unknown action "${type}".`);
  try {
    const result = await handler(env.DB, params.id, member, user, payload || {});
    return json({ ok: true, result });
  } catch (e) {
    if (e.status) return json({ error: e.message }, e.status);
    console.error("action error", type, e);
    return json({ error: "Something went wrong processing that action." }, 500);
  }
}

// functions/api/productions/[id]/members.js
async function onRequestGet4(context) {
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
async function onRequestPost6(context) {
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
  try {
    body = await request.json();
  } catch {
    return errors.badRequest("Body must be JSON.");
  }
  const { email, role, department } = body || {};
  if (!email || !role) return errors.badRequest("Email and role are required.");
  const target = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first();
  if (!target) return errors.badRequest(`No account found for ${email}. Ask them to sign up first, then add them here.`);
  await env.DB.prepare(
    `INSERT INTO production_members (production_id, user_id, role, department) VALUES (?,?,?,?)
     ON CONFLICT(production_id, user_id) DO UPDATE SET role = excluded.role, department = excluded.department`
  ).bind(params.id, target.id, role, department || null).run();
  return json({ ok: true });
}

// worker.js
var json2 = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (!env.DB) {
      return json2({
        error: "No database is bound. In the Cloudflare dashboard open Settings, then Functions, then D1 database bindings, and add a binding named DB."
      }, 503);
    }
    const ctxFor = (params = {}) => ({ request, env, params, waitUntil: ctx.waitUntil.bind(ctx) });
    try {
      if (path === "/api/health" && method === "GET") {
        const out = { database: "unknown", tables: null, missing: [], crypto: "unknown", iterations: null };
        const EXPECTED = [
          "workspaces",
          "users",
          "sessions",
          "productions",
          "production_members",
          "characters",
          "locations",
          "scenes",
          "scene_cast",
          "elements",
          "element_scenes",
          "people",
          "shooting_days",
          "day_strips",
          "call_sheets",
          "call_sheet_ack",
          "dprs",
          "dpr_scenes",
          "delays",
          "incidents",
          "accounts",
          "budget_lines",
          "purchase_orders",
          "expenses",
          "audit_log"
        ];
        try {
          const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
          const names = (rows.results || []).map((r) => r.name);
          out.database = "connected";
          out.tables = names.length;
          out.missing = EXPECTED.filter((t) => !names.includes(t));
        } catch (e) {
          out.database = "error: " + e.message;
        }
        try {
          const t0 = Date.now();
          const { hash, salt } = await hashPassword("health-check-password", env);
          out.hashMs = Date.now() - t0;
          out.crypto = await verifyPassword("health-check-password", hash, salt) ? "ok" : "verify failed";
          out.iterations = Number(salt.split("$")[0]);
          out.cpuBudget = out.hashMs < 8 ? "comfortable" : "TIGHT \u2014 lower PBKDF2_ITERATIONS";
        } catch (e) {
          out.crypto = "error: " + e.message;
        }
        out.ready = out.database === "connected" && out.missing.length === 0 && out.crypto === "ok";
        return json2(out, out.ready ? 200 : 503);
      }
      if (path === "/api/auth/signup" && method === "POST") return await onRequestPost(ctxFor());
      if (path === "/api/auth/signin" && method === "POST") return await onRequestPost2(ctxFor());
      if (path === "/api/auth/signout" && method === "POST") return await onRequestPost3(ctxFor());
      if (path === "/api/auth/me" && method === "GET") return await onRequestGet(ctxFor());
      if (path === "/api/productions") {
        if (method === "GET") return await onRequestGet2(ctxFor());
        if (method === "POST") return await onRequestPost4(ctxFor());
      }
      const m = path.match(/^\/api\/productions\/([^/]+)\/(state|actions|members)$/);
      if (m) {
        const params = { id: decodeURIComponent(m[1]) };
        const leaf = m[2];
        if (leaf === "state" && method === "GET") return await onRequestGet3(ctxFor(params));
        if (leaf === "actions" && method === "POST") return await onRequestPost5(ctxFor(params));
        if (leaf === "members" && method === "GET") return await onRequestGet4(ctxFor(params));
        if (leaf === "members" && method === "POST") return await onRequestPost6(ctxFor(params));
      }
      return json2({ error: `No route for ${method} ${path}` }, 404);
    } catch (e) {
      console.error("worker error", method, path, e);
      return json2({
        error: "Something went wrong on the server.",
        detail: String(e && e.message ? e.message : e),
        hint: "Open /api/health on this site for a setup diagnosis."
      }, 500);
    }
  }
};
export {
  worker_default as default
};
