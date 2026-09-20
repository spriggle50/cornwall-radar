# Cornwall Radar — Phase 1

Everything lives in this one folder now — no separate `backend`/`frontend`
split. That was the cause of the earlier Railway "Root Directory" mess and a
git submodule mix-up; this structure removes the need for either.

## Important — be aware of this before you trust the data sources

The environment this was written in blocks outbound calls to almost every
external site except npm's registry and GitHub. So: the weather (Open-Meteo),
wildlife (GBIF), and news (RSS) code is written correctly against each API's
real, documented response shape, but it was never actually proven against a
live response from that environment. Traffic and buses need your own free
API keys (TomTom, BODS) before they do anything at all. The first thing to
do is run this locally and actually look at what comes back.

## Setup from scratch

1. Delete your old local `cornwall-radar` folder entirely, and delete the
   `spriggle50/cornwall-radar` GitHub repo too (Settings → scroll to the
   bottom → Delete this repository) — cleanest way to leave the earlier
   submodule mess behind rather than fight it.
2. Unzip this new folder somewhere, e.g. `C:\cornwall-radar`.
3. Create a **new**, empty GitHub repo (same name or different, doesn't
   matter) — don't initialise it with a README/gitignore on GitHub's side,
   since you already have your own here.
4. From inside `C:\cornwall-radar`:

```powershell
npm install
npm start
```

Open `http://localhost:3000` and check what actually comes back for
weather/wildlife/news before doing anything else.

5. Then set up git — this time everything happens in exactly one folder,
   so there's no "which directory am I in" ambiguity:

```powershell
git init
git add .
git commit -m "Cornwall Radar - Phase 1"
git remote add origin https://github.com/spriggle50/<your-new-repo-name>.git
git branch -M main
git push -u origin main
```

6. Check the repo on GitHub afterwards — `src`, `public`, `package.json`
   etc. should all show up as normal folders and files, no arrow icons.

## Deploying to Railway

Since `package.json` is now at the project root, **no Root Directory
setting is needed at all** — leave it blank/default. New Project → Deploy
from GitHub repo → pick the repo → in the Variables tab add
`TOMTOM_API_KEY` and `BODS_API_KEY` with your real values → deploy.

## What's deliberately not built yet

Accounts, saved locations, personalised alerts, and Stripe billing — all
speced in the main Cornwall-Radar-Spec.md document. `schema.sql` here has
the tables ready to go for when you get to that (Phase 1.5), on a separate
new Supabase project — nothing here touches Spriggle.

## Staging environment

There are now two fully separate copies of this app:

- **Production** — `main` branch → Railway's production environment →
  cornwallradar.co.uk → its own Supabase project → real (well, sandbox-
  Stripe) customer data.
- **Staging** — `staging` branch → Railway's staging environment → its own
  free `*.up.railway.app` URL → a separate `cornwall-radar-staging`
  Supabase project → safe to break, no real data.

Workflow: do new/risky work on the `staging` branch, push it, test it on
staging's own URL, and only merge into `main` once it's proven safe —
that's what actually deploys to the real site.

```
git checkout staging   # switch to the staging branch to make changes
# ...make changes, commit, push — Railway auto-deploys staging...
git checkout main
git merge staging       # only once staging has been tested and is good
git push                # this is what deploys to production
```

Both environments share the same Stripe sandbox, SMTP2GO, TomTom, BODS
etc. keys — only `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
`SUPABASE_SERVICE_ROLE_KEY` and `APP_BASE_URL` differ between the two, and
the staging Supabase project needs its own Authentication → URL
Configuration set to staging's Railway URL (same fix as production's
magic-link redirect issue, just against the staging project).

Note: Supabase's free-plan project limit (2 active free projects) is
tracked per-person across every organisation you're an owner/admin of, not
per-organisation — this is what made adding a second free Cornwall Radar
project briefly blocked until a project in another organisation was
paused to free up the quota.

## Account/login improvements — built

Phase 1.5 shipped with magic-link (passwordless email) sign-in only. Since
then, all of the following have been built and confirmed working
end-to-end on staging: password-based login/signup alongside the magic
link, MFA (TOTP) enrollment enforced both client- and server-side, a
forgot/reset-password flow, and letting a user permanently delete their own
account (cancelling any active Stripe subscription first, then removing
the Supabase auth user — every dependent row cascades automatically).

## The fuller alert engine — built

The one-a-day morning digest (`jobs/morningDigest.js`) has been joined by
three more alert types, all managed from `routes/alerts.js` and actually
dispatched by `jobs/alertEngine.js`:

- **Traffic alerts** — a genuine A-to-B route check (e.g. home → work) via
  the TomTom Routing API (`fetchers/routing.js`), not just a radius of
  incidents around one point. Alerts when the route's current traffic
  delay is at or above a threshold you choose (5-60 min). Needs two saved
  locations to set up. Untested against a live TomTom response from this
  environment, same caveat as this project's other fetchers — check it
  works once deployed.
- **Weather alerts** — Cornwall Radar's own threshold check (high wind
  gusts, heavy rain, extreme heat/cold, or an active EA flood/river
  warning) for a saved location. Explicitly NOT an official Met Office
  warning — the email itself says so.
- **Wildlife nearby** — a species recently logged (GBIF) within range of a
  saved location. Not filtered by rarity/notability (no such data source
  is wired up), so it dedupes per species per ~2-week window rather than
  per sighting, to avoid becoming a firehose of routine records.

Also: the morning digest is no longer limited to one at a time — a
consumer can now set up a digest (or any of the three alerts above) for
each of their saved locations independently, from the account panel.

**No setup needed beyond deploying this code**: no new environment
variables, no schema changes (the table this all runs on, `alert_preferences`,
was already in `schema.sql` from Phase 1.5 with exactly this in mind), and
no new external cron/pinger to add — the alert engine runs from the exact
same `GET /api/cron/morning-digest` URL that's already being pinged
hourly, alongside the digest job it always ran.
