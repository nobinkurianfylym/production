# Setting this up — no terminal needed

Four steps in the Cloudflare dashboard. About five minutes.

---

## 1. Make the database

**Storage & Databases → D1 → Create database**

Name it `fpms`. Click Create.

## 2. Create the tables

Still in that database, open the **Console** tab.

Open `SCHEMA-paste-into-d1-console.sql` (in this folder) in any text editor,
select all, copy, paste into the console, and run.

Only ever needs doing once.

## 3. Upload the site

**Workers & Pages → Create → Pages → Upload assets**

Name the project `fpms`. Drag in **the contents of this folder** — the
`index.html`, the `assets` folder, `_worker.js`, all of it. Not the folder
itself, and not a zip.

Click Deploy. You'll get a URL ending in `.pages.dev`.

## 4. Connect the database to the site

**Your project → Settings → Functions → D1 database bindings → Add binding**

- Variable name: `DB` — exactly that, capital letters
- Database: `fpms`
- Make sure you're on the **Production** tab, not Preview

Save, then **Deployments → Retry deployment** on the most recent one. Bindings
only attach to new deployments, so this step is not optional.

---

## 5. Check it before you sign up

Visit **`your-site.pages.dev/api/health`**

You want to see `"ready": true`. The full response tells you exactly what is
and isn't working:

```json
{
  "database": "connected",
  "tables": 25,
  "missing": [],
  "crypto": "ok",
  "iterations": 10000,
  "hashMs": 4,
  "cpuBudget": "comfortable",
  "ready": true
}
```

| What you see | What it means |
|---|---|
| `"database": "error: ..."` | Step 4 didn't take. Check the variable name is exactly `DB`, then redeploy. |
| `"tables": 0` or a list in `missing` | Step 2 didn't finish. Re-paste the schema. If the console truncated it, paste in two or three chunks. |
| `"cpuBudget": "TIGHT"` | Hashing is close to the CPU limit. Set `PBKDF2_ITERATIONS` to `8000` in Settings → Environment variables. |
| `"ready": true` | Go and create your account. |

Then open the site and click **Create account**. The first person to sign up
owns the workspace and is the producer.

To add your line producer or AD: they create their own account first, then you
use **Manage crew access** in the left sidebar to add them by that email and
pick a role.

---

## A note on password security

Cloudflare's free tier allows 10ms of CPU per request. Proper password hashing
is deliberately expensive — the OWASP-recommended 210,000 PBKDF2 iterations
needs about 39ms, which gets the request killed. So the default here is 10,000
iterations, which fits comfortably.

That is weaker than best practice against someone who steals the database and
cracks passwords offline. Two ways to fix it properly when you're ready:

- **Workers Paid** (currently $5/month) lifts the CPU limit. Then set
  `PBKDF2_ITERATIONS` = `210000` in Settings → Environment variables. Existing
  accounts keep working — each hash records the count it was made with.
- **Cloudflare Access** (Zero Trust → Access) puts email or SSO login in front
  of the whole site, at which point these hashes stop being what protects you.

Do one of these before the site holds real crew contact details or budgets.

---

## If something breaks later

Every server error now returns a `detail` field naming the actual problem, and
`/api/health` diagnoses setup issues. Between those two you should be able to
see what's wrong rather than guess.

For a backup: **D1 → fpms → Settings → Time Travel** restores the database to
any point in the last 30 days. Find that button before you need it.
