# FPMS — Film Production Management System

Script → breakdown → stripboard → call sheets → daily reports → commitment-based
cost control, with real accounts, roles, and a real database.

Vite + React frontend, Cloudflare Pages Functions backend, Cloudflare D1 (SQLite)
for storage. No paid services required to run it.

---

## Quick start (local, demo only)

```bash
npm install
npm run dev          # http://localhost:5173
```

Without a database bound, the app falls back to **demo mode** — the seeded
production *The Last Bus to Kolar*, stored in your browser only. Good for
showing someone how it works. Not where you put a real film.

---

## Deploying for real

### 1. Create the database

```bash
npm install -g wrangler
wrangler login
wrangler d1 create fpms
```

That prints a `database_id`. Put it in `wrangler.toml`, replacing the
placeholder.

### 2. Apply the schema

```bash
wrangler d1 execute fpms --file=migrations/0001_init.sql --remote
```

### 3. Deploy

```bash
npm run build
wrangler pages deploy dist --project-name=fpms
```

### 4. Bind the database to the Pages project

In the Cloudflare dashboard: **Workers & Pages → your project → Settings →
Functions → D1 database bindings**. Add a binding with variable name `DB`
pointing at the `fpms` database. Redeploy once after binding.

### 5. Create the first account

Open the site and choose **Create account**. The first person to sign up
creates the workspace. Anything you create, you're the producer on.

To bring the rest of the unit on: have them sign up, then use **Manage crew
access** in the left rail to add them by the email they used, with a role.

---

## Roles

Enforced server-side on every write, in `functions/api/lib/permissions.js`.
The UI also hides controls a role can't use, but that's a courtesy — the
boundary is the server, because a browser console can call `fetch` directly.

| Role | Can do |
|---|---|
| **Producer** | Everything, including approving purchase orders that exceed their account |
| **Line producer** | Schedule, budget, approvals — but *cannot* approve over budget |
| **1st AD** | Script, breakdown, stripboard, call sheets, daily reports |
| **2nd AD** | Call sheets, daily reports, expense claims |
| **Director** | Script and breakdown |
| **Department head** | Their own department's budget and breakdown; can raise POs |
| **Accountant** | Full financial access, approvals, cost report |
| **Post supervisor** | Read access plus post-production lines |
| **Crew** | Read-only |
| **Viewer** | Read-only, no rates |

Rates and individual pay are stripped from the API response entirely for roles
without `view_rates` — not hidden in the UI, never sent.

---

## The rules that are actually enforced

These are business rules, not validation niceties, and they're tested:

- **A scene lives on exactly one shooting day.** Enforced by a `UNIQUE`
  constraint on `day_strips.scene_id`, so even a malformed request can't
  double-book a strip.
- **An approved purchase order commits budget immediately.** Available =
  budget − actual − committed. A PO that exceeds available is blocked for the
  line producer and requires a producer, and the override is written to the
  audit log against their name.
- **An approved daily production report is locked.** Further edits return 409.
  Corrections are issued as a revision, never a silent edit.
- **Approving a DPR carries part-shot scenes back to the board** and advances
  the current shooting day.
- **Planned page counts are frozen onto the DPR at approval**, so rescheduling
  a scene later can't retroactively rewrite what a wrapped day was supposed to
  achieve.
- **Re-publishing a call sheet resets read receipts.** An acknowledgement
  against Revision 1 doesn't count as read for Revision 2.

---

## Layout

```
wrangler.toml                D1 binding — set your database_id here
migrations/0001_init.sql     the schema — 25 tables, run once
functions/api/
  lib/auth.js                PBKDF2 hashing, session tokens (Web Crypto only)
  lib/db.js                  scoped queries, audit helper, error shapes
  lib/permissions.js         the role matrix — the security boundary
  lib/session.js             resolves the session cookie to a user
  lib/actions.js             every state change, with its permission check
  auth/*                     signup, signin, signout, me
  productions/*              list, create, read state, dispatch actions, members
src/
  App.jsx                    the application
  localEngine.js             demo-mode reducer, mirrors actions.js
  api.js                     fetch wrapper
  AuthScreen.jsx             sign in / create account
  ProductionPicker.jsx       choose or create a production
  BurnChart.jsx              recharts, lazy-loaded
  storage.js                 demo-mode persistence
test/d1-shim.mjs             makes node:sqlite look like D1, for testing
```

---

## Testing

`test/d1-shim.mjs` wraps Node's built-in SQLite so the real Worker code runs
against a real database engine without deploying. The suite covers password
hashing, the permission matrix, schema integrity (cascades, uniqueness,
foreign keys), every action, and parity between the server engine and the
demo reducer — 30 checks, all passing at time of writing.

---

## What this still isn't

Honest list, because the gap matters:

- **No offline support and no mobile app.** It's a responsive web app. On a
  location with no signal it will not work. This is the single biggest gap
  against the requirements document, and it is not a small piece of work.
- **Publishing a call sheet doesn't send anything.** No email, SMS or WhatsApp.
  Receipts are marked by hand. Distribution is a real integration and hasn't
  been built.
- **No PDF generation.** Call sheets print through the browser. CSV exports work.
- **No file or document storage.** Contracts, permits, receipts and photos
  can't be attached.
- **No MFA, no password reset, no email verification.** Sessions expire after
  14 days. Put Cloudflare Access in front if this holds anything sensitive.
- **No equipment or post-production modules.** Phase 2–3 in the spec.
- **PII is deliberately absent from the schema.** No bank details, no ID
  documents. Adding them needs a separately-gated table with access logging,
  not a column on `people`.

Before running a real production on this, back up the D1 database on a
schedule (`wrangler d1 export`), and test the restore.
