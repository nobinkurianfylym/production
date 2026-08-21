/* Permission matrix — mirrors §2.2 of the requirements spec.
   ────────────────────────────────────────────────────────────────────────
   FR-ROLE-001 requires access control scoped to a production and a
   department. This is enforced HERE, server-side, on every write endpoint.
   The frontend also hides controls a role can't use — but that's a UX
   courtesy, not the security boundary. The boundary is this file, because
   a browser's DevTools can call fetch() directly regardless of what
   buttons are rendered.

   CAN is a table of [role][capability] -> boolean | "own-department".
   "own-department" means the check also compares the request's department
   against the member's department (FR-ROLE-001's Gaffer/Lighting example). */

const ROLES = [
  "producer", "line_producer", "first_ad", "second_ad", "director",
  "dept_head", "accountant", "post_supervisor", "crew", "viewer",
];

const CAN = {
  // financial data — FR-ROLE-004: invisible by default except these roles
  view_rates:        { producer: true, line_producer: true, accountant: true },
  view_budget:       { producer: true, line_producer: true, accountant: true, dept_head: "own-department" },
  edit_budget:       { producer: true, line_producer: true, accountant: true },
  raise_po:          { producer: true, line_producer: true, accountant: true, dept_head: true },
  approve_po:        { producer: true, line_producer: true, accountant: true },
  approve_po_over_budget: { producer: true },   // escalation tier — §9.4 AC-3
  submit_expense:    { producer: true, line_producer: true, accountant: true, dept_head: true, second_ad: true },
  approve_expense:   { producer: true, line_producer: true, accountant: true },

  // schedule & script
  edit_script:       { producer: true, line_producer: true, first_ad: true, director: true },
  edit_breakdown:    { producer: true, line_producer: true, first_ad: true, dept_head: true },
  edit_schedule:     { producer: true, line_producer: true, first_ad: true },
  publish_callsheet: { producer: true, line_producer: true, first_ad: true, second_ad: true },
  submit_dpr:        { producer: true, line_producer: true, first_ad: true, second_ad: true },
  approve_dpr:       { producer: true, line_producer: true },

  // people & locations
  edit_people:       { producer: true, line_producer: true, first_ad: true },
  view_pii:          { producer: true, line_producer: true, accountant: true },
  edit_locations:    { producer: true, line_producer: true, first_ad: true, dept_head: true },

  // production settings
  manage_members:    { producer: true },
  edit_production:   { producer: true, line_producer: true },
};

export function can(member, capability, ctx = {}) {
  if (!member) return false;
  const rule = CAN[capability]?.[member.role];
  if (rule === true) return true;
  if (rule === "own-department") return !!ctx.department && ctx.department === member.department;
  return false;
}

export function requireCan(member, capability, ctx) {
  if (!can(member, capability, ctx)) {
    const err = new Error(`Role "${member?.role || "none"}" cannot ${capability.replace(/_/g, " ")}.`);
    err.status = 403;
    throw err;
  }
}

export { ROLES };
