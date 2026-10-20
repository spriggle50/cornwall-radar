// Sends the next batch of pending Cornwall Radar outreach emails via Resend.
//
// Designed to be run on a schedule (e.g. a Railway cron job every 30 minutes)
// rather than all at once — each run sends --limit emails (default 1) and
// exits. Re-running is safe: it only ever picks rows with status='pending'.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RESEND_API_KEY=... \
//   node send_batch.mjs [--group "Food & Drink"] [--limit 1]
//
// Requires: npm install @supabase/supabase-js resend
//
// Group order: if --group isn't passed, the script works through
// GROUP_ORDER below, one group at a time, moving to the next group only
// once the current one has no pending rows left. Edit GROUP_ORDER to
// change which category gets emailed first.

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { readFileSync } from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.FROM_ADDRESS || "Cornwall Radar <hello@mail.cornwallradar.co.uk>";
// Sends come FROM the mail. subdomain (keeps sending reputation isolated from
// the main domain), but REPLIES go to a real mailbox on the main domain —
// mail.cornwallradar.co.uk has no inbox set up to receive them.
const REPLY_TO_ADDRESS = process.env.REPLY_TO_ADDRESS || "hello@cornwallradar.co.uk";
const UNSUBSCRIBE_ADDRESS = process.env.UNSUBSCRIBE_ADDRESS || "unsubscribe@cornwallradar.co.uk";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
  console.error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and RESEND_API_KEY first.");
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const GROUP_FILTER = getArg("group", null);
const LIMIT = parseInt(getArg("limit", "1"), 10);
// --test-to redirects the send to this address instead of the real lead's
// email, and skips updating the lead's status — so you can safely preview
// real content (real business name, real category copy) without emailing
// an actual lead or using up one of their one-shot sends.
const TEST_TO = getArg("test-to", null);

const GROUP_ORDER = [
  "Food & Drink",
  "Things to Do",
  "Stay",
  "Shopping & Lifestyle",
  "Property, Homes & Gardens",
  "Business & Professional Services",
  "Rest, Relaxation & Beauty",
  "Weddings",
  "Dogs & Pet Services",
  "Holiday Letting & Housekeeping",
];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(RESEND_API_KEY);

const benefitCopy = JSON.parse(readFileSync("./benefit_copy.json", "utf-8"));

function renderEmail({ business_name, campaign_group }) {
  const copy = benefitCopy[campaign_group];
  if (!copy) {
    throw new Error(`No benefit copy defined for campaign_group "${campaign_group}"`);
  }
  const subject = copy.subject.replaceAll("{{business_name}}", business_name);
  const body = copy.body.replaceAll("{{business_name}}", business_name);

  const html = `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.5;">
      <p>Hi there,</p>
      <p>${body}</p>
      <p>
        It costs nothing to list ${business_name} — no commission, no catch, no auto-renewal trap.
        Just reply to this email and we'll get you added, or if you'd rather do it yourself,
        head to <a href="https://www.cornwallradar.co.uk/directory">cornwallradar.co.uk/directory</a>
        and click "List your business free" (you'll need to set up a free account first).
      </p>
      <p>Other benefits of creating a free account:</p>
      <ul style="padding-left: 20px; margin: 4px 0 16px;">
        <li>Add vouchers for visitors — these show on our vouchers card on the homepage</li>
        <li>List any jobs you're advertising in our local jobs section</li>
      </ul>
      <p>All part of the same free listing, no extra cost.</p>
      <p>All the best,<br/>Your Cornwall Radar Little Helpers</p>
      <p style="font-size: 12px; color: #777; margin-top: 32px;">
        You're receiving this because ${business_name}'s contact details are listed online
        and available to the public. If you'd rather not hear from us again,
        just reply "no thanks" or email
        <a href="mailto:${UNSUBSCRIBE_ADDRESS}">${UNSUBSCRIBE_ADDRESS}</a> and we won't contact you again.
      </p>
    </div>
  `.trim();

  const text = `Hi there,\n\n${body}\n\nIt costs nothing to list ${business_name} — no commission, no catch, no auto-renewal trap. Just reply to this email and we'll get you added, or if you'd rather do it yourself, head to https://www.cornwallradar.co.uk/directory and click "List your business free" (you'll need to set up a free account first).\n\nOther benefits of creating a free account:\n- Add vouchers for visitors — these show on our vouchers card on the homepage\n- List any jobs you're advertising in our local jobs section\n\nAll part of the same free listing, no extra cost.\n\nAll the best,\nYour Cornwall Radar Little Helpers\n\n---\nYou're receiving this because ${business_name}'s contact details are listed online and available to the public. If you'd rather not hear from us again, just reply "no thanks" or email ${UNSUBSCRIBE_ADDRESS} and we won't contact you again.`;

  return { subject, html, text };
}

// Every email address that's ever been marked 'unsubscribed', anywhere in
// the table — not just whichever row id got flagged. A lead's status lives
// on one specific row, but the same email can end up in more than one row
// (a later re-scrape under a slightly different business name, a stray
// duplicate from before a dedupe pass existed), and a fresh row like that
// would otherwise sit there as status='pending' and get emailed again
// despite the opt-out. Checked against every batch this script sends,
// regardless of which row's id ends up matching.
async function unsubscribedEmails() {
  const { data, error } = await supabase
    .from("leads")
    .select("email")
    .eq("status", "unsubscribed");
  if (error) throw error;
  return new Set((data || []).map((row) => row.email.trim().toLowerCase()));
}

async function nextGroupWithPending() {
  if (GROUP_FILTER) return GROUP_FILTER;
  for (const group of GROUP_ORDER) {
    const { count, error } = await supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("campaign_group", group)
      .eq("status", "pending");
    if (error) throw error;
    if (count > 0) return group;
  }
  return null;
}

async function main() {
  const group = await nextGroupWithPending();
  if (!group) {
    console.log("No pending leads left in any group. Nothing to send.");
    return;
  }

  const unsubscribed = await unsubscribedEmails();

  // Fetched without a DB-side limit and sliced down to LIMIT after
  // filtering — this project's scale (a few hundred pending rows per group
  // at most) makes that cheap, and it means a run never comes up short of
  // LIMIT just because a few of the oldest pending rows happened to share
  // an email with an unsubscribed one.
  const { data: candidateLeads, error } = await supabase
    .from("leads")
    .select("id, business_name, email, campaign_group")
    .eq("campaign_group", group)
    .eq("status", "pending")
    .order("id", { ascending: true });

  if (error) throw error;

  const skippedUnsubscribed = (candidateLeads || []).filter((lead) => unsubscribed.has(lead.email.trim().toLowerCase()));
  if (skippedUnsubscribed.length) {
    console.log(`Skipping ${skippedUnsubscribed.length} pending row(s) whose email is already unsubscribed:`);
    for (const lead of skippedUnsubscribed) {
      console.log(`  skip (unsubscribed)  ${lead.business_name} <${lead.email}> (id ${lead.id})`);
    }
  }

  const leads = (candidateLeads || [])
    .filter((lead) => !unsubscribed.has(lead.email.trim().toLowerCase()))
    .slice(0, LIMIT);

  if (!leads.length) {
    console.log(`No pending leads found for group "${group}".`);
    return;
  }

  if (TEST_TO) {
    console.log(`TEST MODE: sending to ${TEST_TO} instead of real leads. No lead status will be changed.`);
  }
  console.log(`Sending ${leads.length} email(s) for group "${group}".`);

  for (const lead of leads) {
    const { subject, html, text } = renderEmail(lead);
    const recipient = TEST_TO || lead.email;
    try {
      const { data, error: sendError } = await resend.emails.send({
        from: FROM_ADDRESS,
        replyTo: REPLY_TO_ADDRESS,
        to: recipient,
        subject,
        html,
        text,
      });

      if (sendError) {
        console.error(`  FAILED  ${lead.business_name} <${recipient}>: ${sendError.message}`);
        // A validation_error (bad `to` address, unverified domain, etc.) will
        // never succeed on retry. Leaving the row "pending" meant this exact
        // lead got re-picked every single run (ORDER BY id ascending) and
        // blocked every other pending lead behind it in the group forever —
        // which is what happened with a scraped email missing its final
        // letter. Take it out of the queue instead, reusing the existing
        // "bounced" status (same one a real mail-server bounce would use)
        // so it still shows up for review rather than silently vanishing.
        // Rate limits (429) and server errors (5xx) aren't validation
        // errors, so they're left "pending" and retried as before.
        if (!TEST_TO && sendError.name === "validation_error") {
          await supabase
            .from("leads")
            .update({ status: "bounced", last_error: sendError.message })
            .eq("id", lead.id);
        }
        continue;
      }

      console.log(`  sent    ${lead.business_name} -> ${recipient}  (${data?.id})`);

      if (TEST_TO) {
        continue; // test send only — leave the real lead's row untouched
      }

      await supabase
        .from("leads")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          template_used: group,
          resend_message_id: data?.id ?? null,
        })
        .eq("id", lead.id);
    } catch (err) {
      console.error(`  ERROR   ${lead.business_name} <${lead.email}>:`, err.message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
