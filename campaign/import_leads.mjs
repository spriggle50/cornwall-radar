// Imports new rows from cornwall_leads_grouped.csv into Supabase's `leads`
// table, so send_batch.mjs has something pending to work through. This is
// the "import" script campaign/package.json has always referred to — a
// local, run-by-hand tool (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
// passed in as env vars at run time, never stored here), same as
// campaign/send_batch.mjs and campaign/unsubscribe.mjs, both already
// tracked in git. This file used to be the odd one out, left untracked —
// which is exactly how it went missing once before and had to be
// recreated from scratch, matched directly against the real `leads` table
// schema (public.leads — see the create table statement Ady pasted back):
//
//   business_name text not null
//   category      text not null
//   campaign_group text not null
//   town          text null
//   email         text not null, unique, CHECK (email = lower(email))
//   phone         text null
//   website       text null
//   source        text null
//   notes         text null
//   status        text not null default 'pending' (pending/sent/bounced/unsubscribed)
//   unsubscribe_token text null
//   (template_used, sent_at, resend_message_id, last_error, created_at,
//    updated_at are all set later by send_batch.mjs / webhooks — never on import)
//
// Two schema details that matter here:
//   - email has a CHECK (email = lower(email)) constraint, so every address
//     is lowercased before insert, not just compared case-insensitively.
//   - email is UNIQUE, so inserts use upsert(..., { onConflict: "email",
//     ignoreDuplicates: true }) rather than a plain insert — the in-memory
//     pre-filter below already skips known emails, but the upsert is a
//     second line of defence so a same-run duplicate or a race against
//     another import never aborts a whole chunk with a constraint violation.
//
// Safe to re-run against the same CSV any number of times: it only ever
// inserts a row whose (lowercased) email isn't already in the table, so
// running it after adding a fresh batch of leads to the CSV just imports
// the new ones — it never creates a duplicate pending row for a lead that's
// already been sent to, bounced, or unsubscribed. Rows with no email are
// skipped entirely (nothing for send_batch.mjs to send to, and the column
// is NOT NULL anyway).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node import_leads.mjs [--dry-run] [--file path/to.csv]

import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const DRY_RUN = args.includes("--dry-run");
const CSV_PATH = getArg("file", "./cornwall_leads_grouped.csv");

// Chunk size for each insert call — comfortably under PostgREST/Supabase's
// payload limits even for a batch this CSV's biggest single-town additions
// have reached so far (~185 rows), with headroom to spare.
const CHUNK_SIZE = 500;

function newToken() {
  // Same generation as backfill_unsubscribe_tokens.mjs, so a freshly
  // imported row never needs that backfill script run against it.
  return randomBytes(24).toString("base64url");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function existingEmails() {
  // Fetched into memory and compared there rather than one exists-check per
  // CSV row — this project's scale (a few thousand rows total) makes that
  // cheap and avoids thousands of round trips. PAGINATED in PAGE_SIZE
  // chunks via .range() rather than one unbounded .select() — PostgREST
  // silently caps an unbounded select at its own max-rows setting
  // (commonly 1000 on a Supabase project), so a single-shot select here
  // would only ever see the first ~1000 leads and treat every email past
  // that as "new", re-queuing thousands of already-sent/bounced leads for
  // a no-op upsert and making the "N new row(s) to import" count below
  // wildly overstate what's actually new. Looping with .range() until a
  // page comes back short of PAGE_SIZE is how you reliably read "all rows"
  // through PostgREST regardless of that cap.
  const PAGE_SIZE = 1000;
  const emails = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("leads")
      .select("email")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) {
      if (row.email) emails.add(row.email.trim().toLowerCase());
    }
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return emails;
}

function readCsvRows(path) {
  const raw = readFileSync(path, "utf-8");
  return parse(raw, { columns: true, skip_empty_lines: true });
}

async function main() {
  const rows = readCsvRows(CSV_PATH);
  console.log(`Read ${rows.length} row(s) from ${CSV_PATH}.`);

  const existing = await existingEmails();
  console.log(`${existing.size} email(s) already in the leads table.`);

  const seenThisRun = new Set();
  const toInsert = [];
  let skippedNoEmail = 0;
  let skippedAlreadyImported = 0;
  let skippedDuplicateInCsv = 0;

  for (const row of rows) {
    const rawEmail = (row.Email || "").trim();
    if (!rawEmail) {
      skippedNoEmail += 1;
      continue;
    }
    // Required by the leads_email_lowercase CHECK constraint.
    const email = rawEmail.toLowerCase();
    if (existing.has(email)) {
      skippedAlreadyImported += 1;
      continue;
    }
    if (seenThisRun.has(email)) {
      // Shouldn't normally happen — the lead-sourcing process dedupes by
      // email before anything gets appended to the CSV — but guards
      // against inserting the same address twice in one run if it ever
      // does (e.g. a hand edit).
      skippedDuplicateInCsv += 1;
      continue;
    }
    seenThisRun.add(email);

    toInsert.push({
      business_name: row["Business Name"] || "",
      category: row.Category || "",
      campaign_group: row.campaign_group || "",
      town: row.Town || null,
      email,
      phone: row.Phone || null,
      website: row.Website || null,
      source: row["Source Directory"] || null,
      notes: row.Notes || null,
      status: "pending",
      unsubscribe_token: newToken(),
    });
  }

  console.log(
    `${toInsert.length} new row(s) to import ` +
      `(skipped ${skippedNoEmail} with no email, ${skippedAlreadyImported} already in the table` +
      (skippedDuplicateInCsv ? `, ${skippedDuplicateInCsv} duplicate within this run` : "") +
      `).`
  );

  if (!toInsert.length) {
    console.log("Nothing to import.");
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — no rows written. First few rows that would be inserted:");
    for (const row of toInsert.slice(0, 5)) {
      console.log(`  ${row.business_name} <${row.email}> [${row.campaign_group}] (${row.town || "no town"})`);
    }
    if (toInsert.length > 5) console.log(`  ...and ${toInsert.length - 5} more.`);
    return;
  }

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    // upsert + ignoreDuplicates rather than a plain insert: email is UNIQUE,
    // so this is a safety net against the constraint aborting a whole chunk
    // if a duplicate slipped past the in-memory checks above.
    const { error } = await supabase
      .from("leads")
      .upsert(chunk, { onConflict: "email", ignoreDuplicates: true });
    if (error) {
      console.error(`  FAILED inserting rows ${i}-${i + chunk.length - 1}: ${error.message}`);
      continue;
    }
    inserted += chunk.length;
    console.log(`  inserted ${inserted}/${toInsert.length}...`);
  }

  console.log(`Done — ${inserted}/${toInsert.length} row(s) imported.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
