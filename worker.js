/* Pages Advanced Mode entry point.
   ────────────────────────────────────────────────────────────────────────
   Cloudflare's dashboard drag-and-drop upload does not compile a
   functions/ directory — that only happens via `wrangler pages deploy` or
   a Git build. But it DOES run a single `_worker.js` at the root of the
   uploaded folder.

   So this file bundles the same handlers from functions/api/ into one
   worker, routes /api/* to them, and hands everything else to the static
   assets. Result: the full app, database and all, deploys by dragging one
   folder into a browser. No terminal, no npm, no wrangler.

   The logic is identical either way — this is a packaging shim, not a
   second implementation. */

import { hashPassword, verifyPassword } from "./functions/api/lib/auth.js";
import { onRequestPost as signup } from "./functions/api/auth/signup.js";
import { onRequestPost as signin } from "./functions/api/auth/signin.js";
import { onRequestPost as signout } from "./functions/api/auth/signout.js";
import { onRequestGet as me } from "./functions/api/auth/me.js";
import { onRequestGet as listProductions, onRequestPost as createProduction } from "./functions/api/productions/index.js";
import { onRequestGet as getState } from "./functions/api/productions/[id]/state.js";
import { onRequestPost as postActions } from "./functions/api/productions/[id]/actions.js";
import { onRequestGet as listMembers, onRequestPost as addMember } from "./functions/api/productions/[id]/members.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!path.startsWith("/api/")) {
      // Everything that isn't the API is a static asset.
      return env.ASSETS.fetch(request);
    }

    if (!env.DB) {
      return json({
        error: "No database is bound. In the Cloudflare dashboard open Settings, then Functions, then D1 database bindings, and add a binding named DB.",
      }, 503);
    }

    const ctxFor = (params = {}) => ({ request, env, params, waitUntil: ctx.waitUntil.bind(ctx) });

    try {
      // Diagnostics. Checks the three things that actually go wrong at
      // setup time, so a failure names itself instead of being guessed at.
      if (path === "/api/health" && method === "GET") {
        const out = { database: "unknown", tables: null, missing: [], crypto: "unknown", iterations: null };
        const EXPECTED = [
          "workspaces", "users", "sessions", "productions", "production_members",
          "characters", "locations", "scenes", "scene_cast", "elements", "element_scenes",
          "people", "shooting_days", "day_strips", "call_sheets", "call_sheet_ack",
          "dprs", "dpr_scenes", "delays", "incidents", "accounts", "budget_lines",
          "purchase_orders", "expenses", "audit_log",
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
          // Time the hash alone — that is what one signup actually costs
          // against the CPU budget. The verify is separate.
          const t0 = Date.now();
          const { hash, salt } = await hashPassword("health-check-password", env);
          out.hashMs = Date.now() - t0;
          out.crypto = (await verifyPassword("health-check-password", hash, salt)) ? "ok" : "verify failed";
          out.iterations = Number(salt.split("$")[0]);
          out.cpuBudget = out.hashMs < 8 ? "comfortable" : "TIGHT — lower PBKDF2_ITERATIONS";
        } catch (e) {
          out.crypto = "error: " + e.message;
        }
        out.ready = out.database === "connected" && out.missing.length === 0 && out.crypto === "ok";
        return json(out, out.ready ? 200 : 503);
      }

      // /api/auth/*
      if (path === "/api/auth/signup"  && method === "POST") return await signup(ctxFor());
      if (path === "/api/auth/signin"  && method === "POST") return await signin(ctxFor());
      if (path === "/api/auth/signout" && method === "POST") return await signout(ctxFor());
      if (path === "/api/auth/me"      && method === "GET")  return await me(ctxFor());

      // /api/productions
      if (path === "/api/productions") {
        if (method === "GET")  return await listProductions(ctxFor());
        if (method === "POST") return await createProduction(ctxFor());
      }

      // /api/productions/:id/<leaf>
      const m = path.match(/^\/api\/productions\/([^/]+)\/(state|actions|members)$/);
      if (m) {
        const params = { id: decodeURIComponent(m[1]) };
        const leaf = m[2];
        if (leaf === "state"   && method === "GET")  return await getState(ctxFor(params));
        if (leaf === "actions" && method === "POST") return await postActions(ctxFor(params));
        if (leaf === "members" && method === "GET")  return await listMembers(ctxFor(params));
        if (leaf === "members" && method === "POST") return await addMember(ctxFor(params));
      }

      return json({ error: `No route for ${method} ${path}` }, 404);
    } catch (e) {
      // A thrown handler error means a bug, not a rule the caller broke —
      // those come back as proper status codes from inside the handlers.
      console.error("worker error", method, path, e);
      // The message is included deliberately. This runs on the operator's
      // own Cloudflare account, and a generic 500 turns every setup problem
      // into a guessing game. If that trade stops being worth it, drop the
      // detail field and read the message from the Logs tab instead.
      return json({
        error: "Something went wrong on the server.",
        detail: String(e && e.message ? e.message : e),
        hint: "Open /api/health on this site for a setup diagnosis.",
      }, 500);
    }
  },
};
