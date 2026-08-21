/* Local reducer for demo mode (signed out, or "Try the demo").
   ────────────────────────────────────────────────────────────────────────
   Mirrors functions/api/lib/actions.js action-for-action so the UI can call
   the same `mutate(type, payload)` regardless of whether it's talking to
   the real D1 backend or running entirely in the browser. Business rules
   that matter — a locked DPR rejects edits, an over-budget PO needs a
   producer, a scene lives on one day only — are enforced here too, not
   just server-side, so the demo teaches the real behaviour.

   This intentionally does NOT share code with actions.js: that file speaks
   SQL against D1, this speaks plain JS against a JSON tree. Keeping them
   separate but behaviourally identical is verified by test/parity.test.mjs,
   which runs the same scripted sequence of actions through both and
   diffs the outcomes. */

const uid = (p = "x") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const nowISO = () => new Date().toISOString();

const denied = (role, capability) => {
  const e = new Error(`Role "${role}" cannot ${capability.replace(/_/g, " ")}.`);
  e.status = 403;
  throw e;
};

// Same table as functions/api/lib/permissions.js — see that file for the
// authoritative comments on what each capability means.
const CAN = {
  edit_people: { producer: 1, line_producer: 1, first_ad: 1 },
  edit_locations: { producer: 1, line_producer: 1, first_ad: 1, dept_head: 1 },
  edit_budget: { producer: 1, line_producer: 1, accountant: 1 },
  edit_script: { producer: 1, line_producer: 1, first_ad: 1, director: 1 },
  edit_breakdown: { producer: 1, line_producer: 1, first_ad: 1, dept_head: 1 },
  edit_schedule: { producer: 1, line_producer: 1, first_ad: 1 },
  publish_callsheet: { producer: 1, line_producer: 1, first_ad: 1, second_ad: 1 },
  submit_dpr: { producer: 1, line_producer: 1, first_ad: 1, second_ad: 1 },
  approve_dpr: { producer: 1, line_producer: 1 },
  raise_po: { producer: 1, line_producer: 1, accountant: 1, dept_head: 1 },
  approve_po: { producer: 1, line_producer: 1, accountant: 1 },
  approve_po_over_budget: { producer: 1 },
  submit_expense: { producer: 1, line_producer: 1, accountant: 1, dept_head: 1, second_ad: 1 },
  approve_expense: { producer: 1, line_producer: 1, accountant: 1 },
};
const requireCan = (role, cap) => { if (!CAN[cap]?.[role]) denied(role, cap); };

const accountFinancials = (st, accId) => {
  const acc = st.accounts.find((a) => a.id === accId);
  if (!acc) return { budget: 0, actual: 0, committed: 0, available: 0 };
  const budget = acc.lines.reduce((a, l) => a + l.qty * l.rate * (1 + (l.fringe || 0)), 0);
  const actual = st.expenses.filter((x) => x.accId === accId && x.status === "Approved").reduce((a, x) => a + x.amount, 0);
  const committed = st.pos.filter((p) => p.accId === accId && p.status === "Approved").reduce((a, p) => a + p.amount, 0);
  return { budget, actual, committed, available: budget - actual - committed };
};

const withAudit = (st, actorName, action, object, detail = "") => {
  st.audit = [{ ts: nowISO(), actor: actorName, action, object, detail }, ...st.audit].slice(0, 200);
  return st;
};

/* mutate(state, role, actorName, type, payload) -> new state (or throws) */
export function applyLocalAction(state, role, actorName, type, payload = {}) {
  const st = JSON.parse(JSON.stringify(state));
  const p = payload;

  switch (type) {
    case "addPerson": {
      requireCan(role, "edit_people");
      st.people.push({ id: uid("p"), name: p.name, type: p.type === "cast" ? "cast" : "crew",
        dept: p.dept || "", role: p.role || "", phone: p.phone || "", email: p.email || "",
        rate: Number(p.rate) || 0, basis: p.basis || "day", start: p.start || null, end: p.end || null });
      return withAudit(st, actorName, "Added", `Person — ${p.name}`, p.role || "");
    }
    case "addLocation": {
      requireCan(role, "edit_locations");
      st.locations.push({ id: uid("l"), name: p.name, sets: p.sets || [], address: p.address || "",
        lat: p.lat ?? null, lng: p.lng ?? null, contact: p.contact || "", phone: p.phone || "",
        rate: Number(p.rate) || 0, permit: p.permit || "Scouted", permitExpiry: p.permitExpiry || null,
        hospital: p.hospital || "", notes: p.notes || "" });
      return withAudit(st, actorName, "Added", `Location — ${p.name}`);
    }
    case "addAccount": {
      requireCan(role, "edit_budget");
      st.accounts.push({ id: uid("a"), code: p.code, cat: p.cat, name: p.name,
        lines: (p.lines || []).map((l) => ({ id: uid("bl"), desc: l.desc, qty: Number(l.qty) || 1, unit: l.unit || "flat", rate: Number(l.rate) || 0, fringe: Number(l.fringe) || 0 })) });
      return withAudit(st, actorName, "Added", `Account — ${p.code} ${p.name}`);
    }
    case "addScene": {
      requireCan(role, "edit_script");
      st.scenes.push({ id: uid("s"), no: p.no, intExt: p.intExt, set: p.set, dn: p.dn,
        eighths: Number(p.eighths) || 1, storyDay: Number(p.storyDay) || 1, locId: p.locId || null,
        synopsis: p.synopsis || "", cast: p.cast || [] });
      return withAudit(st, actorName, "Added", `Scene ${p.no}`, `${p.intExt}. ${p.set}`);
    }
    case "editScene": {
      requireCan(role, "edit_script");
      const i = st.scenes.findIndex((s) => s.id === p.sceneId);
      if (i === -1) { const e = new Error("Scene not found."); e.status = 404; throw e; }
      st.scenes[i] = { ...st.scenes[i], no: p.no, intExt: p.intExt, set: p.set, dn: p.dn,
        eighths: Number(p.eighths) || 1, storyDay: Number(p.storyDay) || 1, locId: p.locId || null,
        synopsis: p.synopsis || "", cast: p.cast || [] };
      return withAudit(st, actorName, "Edited", `Scene ${p.no}`, `${p.intExt}. ${p.set} — ${p.dn}`);
    }
    case "tagElement": {
      requireCan(role, "edit_breakdown");
      let el = p.existingId ? st.elements.find((e) => e.id === p.existingId) : null;
      if (el) { if (!el.scenes.includes(p.sceneId)) el.scenes.push(p.sceneId); }
      else { el = { id: uid("e"), cat: p.cat, name: p.name, dept: p.dept || "", status: "To source", est: 0, actual: 0, vendor: "", scenes: [p.sceneId] }; st.elements.push(el); }
      return withAudit(st, actorName, "Tagged", `${p.cat} — ${p.name}`, `Scene ${p.sceneNo || ""}`);
    }
    case "untagElement": {
      requireCan(role, "edit_breakdown");
      const el = st.elements.find((e) => e.id === p.elementId);
      if (el) el.scenes = el.scenes.filter((s) => s !== p.sceneId);
      st.elements = st.elements.filter((e) => e.scenes.length > 0);
      return st;
    }
    case "setElementStatus": {
      requireCan(role, "edit_breakdown");
      const el = st.elements.find((e) => e.id === p.elementId);
      if (el) el.status = p.status;
      return withAudit(st, actorName, "Updated", "Element status", p.status);
    }
    case "addDay": {
      requireCan(role, "edit_schedule");
      const n = (st.days[st.days.length - 1]?.n || 0) + 1;
      st.days.push({ id: uid("d"), n, date: p.date, unit: p.unit || "Main", locId: p.locId || null,
        call: p.call || "06:00", shootCall: p.shootCall || "07:00", wrap: p.wrap || "19:00", strips: [], status: "Planned" });
      return withAudit(st, actorName, "Added", "Shooting day", `Day ${n}`);
    }
    case "updateDay": {
      requireCan(role, "edit_schedule");
      const d = st.days.find((x) => x.id === p.dayId);
      if (d) Object.assign(d, {
        ...(p.locId !== undefined && { locId: p.locId }),
        ...(p.call !== undefined && { call: p.call }),
        ...(p.shootCall !== undefined && { shootCall: p.shootCall }),
        ...(p.wrap !== undefined && { wrap: p.wrap }),
      });
      return withAudit(st, actorName, "Changed", `Day ${p.dayN} settings`, p.detail || "");
    }
    case "moveScene": {
      requireCan(role, "edit_schedule");
      st.days.forEach((d) => { d.strips = d.strips.filter((s) => s !== p.sceneId); });
      if (p.toDayId) { const d = st.days.find((x) => x.id === p.toDayId); if (d && !d.strips.includes(p.sceneId)) d.strips.push(p.sceneId); }
      return withAudit(st, actorName, "Moved", `Scene ${p.sceneNo || p.sceneId}`, p.toDayId ? `To day ${p.toDayN}` : "Off the board");
    }
    case "updateLocationPermit": {
      requireCan(role, "edit_locations");
      const l = st.locations.find((x) => x.id === p.locId);
      if (l) l.permit = p.permit;
      return withAudit(st, actorName, "Updated", "Location permit", p.permit);
    }
    case "publishCallSheet": {
      requireCan(role, "publish_callsheet");
      const prev = st.callSheets[p.dayId];
      st.callSheets[p.dayId] = { dayId: p.dayId, version: (prev?.version || 0) + 1, publishedAt: nowISO(), notes: p.notes || "", safety: p.safety || "", ack: [] };
      return withAudit(st, actorName, "Published", `Call sheet — Day ${p.dayN} (Rev ${st.callSheets[p.dayId].version})`);
    }
    case "ackCallSheet": {
      const cs = st.callSheets[p.dayId];
      if (cs && !cs.ack.includes(p.personId)) cs.ack.push(p.personId);
      return st;
    }
    case "saveDPR": {
      requireCan(role, "submit_dpr");
      const existing = st.dprs[p.dayId];
      if (existing?.approved) { const e = new Error("This report is approved and locked. Corrections are issued as a revision, not an edit."); e.status = 409; throw e; }
      st.dprs[p.dayId] = { dayId: p.dayId, plannedEighths: p.plannedEighths, eighthsShot: p.eighthsShot,
        setups: p.setups || 0, firstShot: p.firstShot || "", lunch: p.lunch || "", wrap: p.wrap || "",
        done: p.done || [], part: p.part || [], delays: p.delays || [], incidents: p.incidents || [], approved: false };
      return withAudit(st, actorName, "Saved", `DPR — Day ${p.dayN}`, "Draft");
    }
    case "approveDPR": {
      requireCan(role, "approve_dpr");
      const d = st.days.find((x) => x.id === p.dayId);
      const dpr = st.dprs[p.dayId];
      dpr.approved = true; dpr.approvedBy = actorName;
      d.status = "Completed";
      d.strips = d.strips.filter((s) => !dpr.part.includes(s));
      const next = st.days.find((x) => x.n === d.n + 1);
      if (next) { st.production.currentDayId = next.id; next.status = "Shooting"; }
      return withAudit(st, actorName, "Approved", `DPR — Day ${d.n}`, `${dpr.part.length} scene(s) carried to the board${next ? "" : " · final day"}`);
    }
    case "raisePO": {
      requireCan(role, "raise_po");
      const no = `PO-${String(st.pos.length + 1).padStart(4, "0")}`;
      st.pos.push({ id: uid("po"), no, vendor: p.vendor, accId: p.accId, amount: Number(p.amount) || 0,
        status: "Submitted", raisedBy: actorName, date: p.date, desc: p.desc || "" });
      return withAudit(st, actorName, "Raised", `${no} — ${p.vendor}`, `₹${Number(p.amount) || 0}`);
    }
    case "decidePO": {
      requireCan(role, "approve_po");
      const po = st.pos.find((x) => x.id === p.poId);
      if (!po) { const e = new Error("Purchase order not found."); e.status = 404; throw e; }
      if (p.status === "Approved") {
        const fin = accountFinancials(st, po.accId);
        if (po.amount > fin.available) requireCan(role, "approve_po_over_budget");
      }
      po.status = p.status;
      return withAudit(st, actorName, p.status, `${po.no} — ${po.vendor}`, `₹${po.amount}${role === "producer" && p.status === "Approved" ? " · approved at producer tier" : ""}`);
    }
    case "submitExpense": {
      requireCan(role, "submit_expense");
      st.expenses.push({ id: uid("x"), date: p.date, desc: p.desc, accId: p.accId, dept: p.dept || "",
        amount: Number(p.amount) || 0, mode: p.mode || "Petty cash", status: "Submitted", by: actorName });
      return withAudit(st, actorName, "Submitted", `Expense — ${p.desc}`, `₹${Number(p.amount) || 0}`);
    }
    case "decideExpense": {
      requireCan(role, "approve_expense");
      const x = st.expenses.find((e) => e.id === p.expenseId);
      if (!x) { const e = new Error("Expense not found."); e.status = 404; throw e; }
      x.status = p.status;
      return withAudit(st, actorName, p.status, `Expense — ${x.desc}`, `₹${x.amount}`);
    }
    case "importScript": {
      requireCan(role, "edit_script");
      const nameToId = {};
      st.characters.forEach((c) => (nameToId[c.name] = c.id));
      const newScenes = (p.scenes || []).map((s, i) => {
        const cast = (s.castNames || []).map((nm) => {
          if (!nameToId[nm]) { const id = uid("ch"); st.characters.push({ id, name: nm, castId: null, minor: false }); nameToId[nm] = id; }
          return nameToId[nm];
        });
        return { id: uid("s"), no: p.mode === "append" ? String(st.scenes.length + i + 1) : s.no,
          intExt: s.intExt, set: s.set, dn: s.dn, eighths: s.eighths || 1, storyDay: s.storyDay || 1,
          locId: null, synopsis: s.synopsis || "", cast };
      });
      if (p.mode === "replace") { st.scenes = newScenes; st.days.forEach((d) => { d.strips = []; }); }
      else { st.scenes = [...st.scenes, ...newScenes]; }
      return withAudit(st, actorName, "Imported", "Script", `${newScenes.length} scenes parsed · ${p.mode === "replace" ? "replaced existing" : "appended"}`);
    }
    case "ackAllCallSheet": {
      requireCan(role, "publish_callsheet");
      const cs = st.callSheets[p.dayId];
      if (cs) cs.ack = st.people.map((pp) => pp.id);
      return st;
    }
    default: {
      const e = new Error(`Unknown action "${type}".`);
      e.status = 400;
      throw e;
    }
  }
}
