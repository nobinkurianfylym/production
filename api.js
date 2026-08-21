/* Frontend API client. Every call includes credentials (the session
   cookie); every error response becomes a thrown Error with a readable
   message, so call sites can just try/catch and show api.message. */

async function call(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body on some responses */ }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const api = {
  me: () => call("/auth/me"),
  signup: (data) => call("/auth/signup", { method: "POST", body: JSON.stringify(data) }),
  signin: (data) => call("/auth/signin", { method: "POST", body: JSON.stringify(data) }),
  signout: () => call("/auth/signout", { method: "POST" }),

  listProductions: () => call("/productions"),
  createProduction: (data) => call("/productions", { method: "POST", body: JSON.stringify(data) }),

  getState: (productionId) => call(`/productions/${productionId}/state`),
  act: (productionId, type, payload) =>
    call(`/productions/${productionId}/actions`, { method: "POST", body: JSON.stringify({ type, payload }) }),

  listMembers: (productionId) => call(`/productions/${productionId}/members`),
  addMember: (productionId, data) =>
    call(`/productions/${productionId}/members`, { method: "POST", body: JSON.stringify(data) }),
};
