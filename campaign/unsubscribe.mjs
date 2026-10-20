// Marks one or more leads as unsubscribed, so send_batch.mjs's
// status='pending' queries skip them for good.
//
// Reuses the same approach as send_batch.mjs's "bounced" status (see its
// own comment on that): never deletes the row, just moves it out of the
// pending queue with a status a human glancing at the leads table can
// immediately understand. Matches by email, case-insensitively, since
// scraped addresses aren't guaranteed to be lowercased going in.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node unsubscribe.mjs rachel@cornishcraftbarn.com tony@tonyhowell.co.uk

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

const emails = process.argv.slice(2).map((e) => e.trim()).filter(Boolean);
if (!emails.length) {
  console.error("Usage: node unsubscribe.mjs email1@example.com [email2@example.com ...]");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  for (const email of emails) {
    const { data, error } = await supabase
      .from("leads")
      .update({ status: "unsubscribed" })
      .ilike("email", email)
      .select("id, business_name, email, status");

    if (error) {
      console.error(`  FAILED  ${email}: ${error.message}`);
      continue;
    }
    if (!data || !data.length) {
      console.log(`  not found  ${email} (no matching row in leads — may not have been imported yet)`);
      continue;
    }
    for (const row of data) {
      console.log(`  unsubscribed  ${row.business_name} <${row.email}> (id ${row.id})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
