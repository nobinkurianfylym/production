/* Auth primitives — Web Crypto only, so this file runs unmodified on
   Cloudflare Workers (Pages Functions), in Node 18+, and in a browser.
   No dependency, nothing to npm install, nothing that can go out of date. */

const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

/* PBKDF2 work factor.
   ────────────────────────────────────────────────────────────────────────
   OWASP recommends 210,000 iterations for PBKDF2-SHA256. That takes ~39ms
   of CPU, and Cloudflare Workers' free tier allows 10ms per request — so
   the full figure gets the worker killed mid-signup.

   The default below is chosen for headroom, not for strength: a single
   hash measures ~1.8ms worst-case, about 5x inside the budget. 25,000
   iterations averaged 6.5ms but spiked to 14.5ms, which would fail
   intermittently — and an auth system that works four times out of five
   is worse than one that fails honestly.

   This IS weaker than the OWASP figure against an attacker who has stolen
   the database and is cracking offline. Raise it deliberately when you can:

     • On Workers Paid (currently $5/month) the CPU limit rises far above
       this. Set PBKDF2_ITERATIONS=210000 as an environment variable in
       Settings → Environment variables for full strength.
     • Or put Cloudflare Access in front of the site, in which case
       Cloudflare handles identity and these hashes stop being the thing
       protecting anyone.

   The iteration count is stored alongside each hash, so raising it later
   doesn't lock out existing accounts — old passwords keep verifying at
   the count they were created with. */
const DEFAULT_ITERATIONS = 10_000;

const iterationsFor = (env) => {
  const n = parseInt(env?.PBKDF2_ITERATIONS, 10);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_ITERATIONS;
};

export async function hashPassword(password, env) {
  const iterations = iterationsFor(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256
  );
  // The salt field carries the work factor too, so verification never has
  // to guess: "<iterations>$<salt-hex>".
  return { hash: toHex(bits), salt: `${iterations}$${toHex(salt)}` };
}

export async function verifyPassword(password, hash, storedSalt) {
  // Accept both the new "<iterations>$<hex>" form and any bare-hex salt
  // written before this field carried a work factor.
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
    { name: "PBKDF2", salt: fromHex(saltHex), iterations, hash: "SHA-256" }, key, 256
  );
  const computed = toHex(bits);
  // Constant-time compare — a timing difference on password check is a
  // real side channel, not a theoretical one.
  if (computed.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

/* Session tokens are opaque random values stored in D1, not JWTs. That
   trade means a session is revoked by deleting one row — no denylist,
   no waiting for expiry, works even if you don't trust the token holder
   anymore right now. The cost is a DB read per request, which D1 at the
   edge is built for. */
export function newSessionToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export const SESSION_DAYS = 14;

export function parseCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function sessionCookie(token, maxAgeSeconds) {
  return `fpms_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export const clearSessionCookie = () =>
  "fpms_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
