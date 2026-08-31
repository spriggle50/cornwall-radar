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
