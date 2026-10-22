// One-off: generates a random unsubscribe_token for every lead row that
// doesn't have one yet. Run this once after adding the column (see the
// ALTER TABLE statement in this repo's notes/commit message), and again
// any time a batch of leads gets added some other way without going
// through a path that already sets a token.
//
// Safe to re-run — it only ever touches rows where unsubscribe_token is
// still null, so it never overwrites (and so invalidates) a token that's
// already gone out in a sent email.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node backfill_unsubscribe_tokens.mjs

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function newToken() {
  return randomBytes(24).toString("base64url");
}

async function main() {
  const { data: rows, error } = await supabase
    .from("leads")
    .select("id")
    .is("unsubscribe_token", null);
  if (error) throw error;

  if (!rows.length) {
    console.log("No rows need a token — nothing to do.");
    return;
  }
  console.log(`Backfilling ${rows.length} row(s)...`);

  let done = 0;
  for (const row of rows) {
    const { error: updateErr } = await supabase
      .from("leads")
      .update({ unsubscribe_token: newToken() })
      .eq("id", row.id);
    if (updateErr) {
      console.error(`  FAILED  id ${row.id}: ${updateErr.message}`);
      continue;
    }
    done += 1;
  }
  console.log(`Done — ${done}/${rows.length} rows updated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
