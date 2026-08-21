/* Storage adapter.
   ────────────────────────────────────────────────────────────────────────
   The app was first written inside a claude.ai artifact, where a global
   `window.storage` is provided by the host. That global does not exist on
   the open web, so this module supplies the same tiny interface — get(key)
   and set(key, value) — backed by whatever is actually available.

   Resolution order:
     1. window.storage   — still works unchanged inside claude.ai
     2. /api/state       — Cloudflare KV, only if VITE_REMOTE_STATE=true
     3. localStorage     — the default for a Pages deployment
     4. memory           — last resort, so the app never hard-fails

   Read the warning above the remote backend before you switch it on.      */

const PREFIX = "fpms:";
const REMOTE = import.meta.env.VITE_REMOTE_STATE === "true";

let mem = new Map();

const memoryBackend = {
  name: "memory",
  async get(key) {
    return mem.has(key) ? { key, value: mem.get(key) } : null;
  },
  async set(key, value) {
    mem.set(key, value);
    return { key, value };
  },
};

const localBackend = {
  name: "local",
  async get(key) {
    const v = window.localStorage.getItem(PREFIX + key);
    return v == null ? null : { key, value: v };
  },
  async set(key, value) {
    try {
      window.localStorage.setItem(PREFIX + key, value);
    } catch (e) {
      // Quota exceeded, or Safari private mode. Degrade rather than lose
      // the session — the caller surfaces this as "saved in this session only".
      return memoryBackend.set(key, value);
    }
    return { key, value };
  },
};

/* WARNING — the remote backend has no authentication.
   A Pages site with KV enabled and no auth in front of it means anyone who
   has the URL can read the budget, the crew phone numbers and the script,
   and can overwrite them. Do not enable this on a public deployment for a
   real production. Put Cloudflare Access (or your own auth) in front first. */
const remoteBackend = {
  name: "remote",
  async get(key) {
    const r = await fetch(`/api/state?key=${encodeURIComponent(key)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`state read failed: ${r.status}`);
    return r.json();
  },
  async set(key, value) {
    const r = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (!r.ok) throw new Error(`state write failed: ${r.status}`);
    return { key, value };
  },
};

const pick = () => {
  if (typeof window === "undefined") return memoryBackend;
  if (window.storage && typeof window.storage.get === "function") {
    return { name: "artifact", get: (k) => window.storage.get(k), set: (k, v) => window.storage.set(k, v) };
  }
  if (REMOTE) return remoteBackend;
  try {
    const probe = "__fpms_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return localBackend;
  } catch (e) {
    return memoryBackend;
  }
};

const backend = pick();

export const storageBackend = backend.name;

export const storage = {
  get: (key) => backend.get(key),
  set: (key, value) => backend.set(key, value),
};
