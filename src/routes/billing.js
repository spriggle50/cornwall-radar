// Stripe checkout, billing portal, and webhook for the paid tier.
//
// `webhookHandler` is exported separately from `router` — NOT mounted as a
// route inside the router — because Stripe's signature check needs the
// exact raw request bytes, not the parsed JSON body express.json() would
// otherwise produce. server.js mounts it directly with express.raw()
// before the app-wide express.json() call; see the comment there for why
// the order matters. Every other route in this file is a normal JSON route
// and works exactly like the rest of the app.
const express = require('express');
const router = express.Router();
const { stripe } = require('../lib/stripeClient');
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');

const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

function requireStripeConfigured(req, res, next) {
  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(503).json({ error: 'Billing is not configured on this server yet (STRIPE_SECRET_KEY / STRIPE_PRICE_ID missing).' });
  }
  next();
}

// POST /api/billing/create-checkout-session — starts a Stripe Checkout flow
// for the one subscription price this project sells. Reuses an existing
// Stripe customer if this consumer already has one (e.g. a past cancelled
// subscription), rather than letting Stripe create a duplicate customer.
router.post('/create-checkout-session', requireAuth, requireStripeConfigured, async (req, res) => {
  try {
    const { data: consumer } = await supabaseAdmin
      .from('consumers')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .maybeSingle();

    const hasStripeCustomer = !!(consumer && consumer.stripe_customer_id);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer: hasStripeCustomer ? consumer.stripe_customer_id : undefined,
      customer_email: hasStripeCustomer ? undefined : req.user.email,
      client_reference_id: req.user.id,
      success_url: `${APP_BASE_URL}/?billing=success`,
      cancel_url: `${APP_BASE_URL}/?billing=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] checkout session failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// POST /api/billing/create-portal-session — lets an existing subscriber
// manage or cancel their plan on Stripe's own hosted page, rather than this
// project building its own cancel/upgrade UI.
router.post('/create-portal-session', requireAuth, requireStripeConfigured, async (req, res) => {
  try {
    const { data: consumer, error } = await supabaseAdmin
      .from('consumers')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!consumer || !consumer.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found yet — subscribe first' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: consumer.stripe_customer_id,
      return_url: `${APP_BASE_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] portal session failed:', err.message);
    res.status(500).json({ error: 'Could not open the billing portal' });
  }
});

// Applies a status update to whichever of the two account tables actually
// has this Stripe customer — safe to run against both unconditionally
// because each table's stripe_customer_id comes from its own dedicated
// Stripe customer (routes/business.js never reuses a consumer's customer
// id, or vice versa), so at most one of these two updates ever matches a
// row; the other is a harmless no-op.
async function updateStatusByStripeCustomer(stripeCustomerId, status) {
  await supabaseAdmin.from('consumers').update({ subscription_status: status }).eq('stripe_customer_id', stripeCustomerId);
  await supabaseAdmin.from('businesses').update({ subscription_status: status }).eq('stripe_customer_id', stripeCustomerId);
}

async function upsertSubscriptionStatus(sub) {
  const status = (sub.status === 'active' || sub.status === 'trialing') ? 'active' : sub.status;
  await updateStatusByStripeCustomer(sub.customer, status);

  // The `subscriptions` history table predates the business directory and
  // is consumer-only for now — a business's Featured status is tracked
  // just via businesses.subscription_status, no separate history table yet.
  const { data: consumer } = await supabaseAdmin
    .from('consumers')
    .select('id')
    .eq('stripe_customer_id', sub.customer)
    .maybeSingle();
  if (consumer) {
    await supabaseAdmin
      .from('subscriptions')
      .upsert({
        consumer_id: consumer.id,
        stripe_subscription_id: sub.id,
        stripe_price_id: sub.items?.data?.[0]?.price?.id || '',
        status: sub.status,
        current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      }, { onConflict: 'stripe_subscription_id' });
  }
}

// The webhook itself — Stripe calls this directly, with no Authorization
// header from a logged-in user. Authenticity comes entirely from the
// signature check below (using the raw body server.js hands it), not from
// requireAuth — there's no "user" making this request, Stripe is.
async function webhookHandler(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Webhook not configured');
  }
  if (!supabaseConfigured()) {
    return res.status(503).send('Accounts not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw Buffer — see the express.raw() mount in server.js
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[billing] webhook signature check failed:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const accountId = session.client_reference_id;
        // Only this event is keyed by OUR id (client_reference_id) rather
        // than Stripe's customer id, so it's the one place that genuinely
        // needs the accountType tag to know which table to attach the new
        // Stripe customer to — see the metadata comment in
        // routes/business.js's create-checkout-session.
        const isBusiness = session.metadata && session.metadata.accountType === 'business';
        if (accountId && session.customer) {
          await supabaseAdmin
            .from(isBusiness ? 'businesses' : 'consumers')
            .update({ stripe_customer_id: session.customer, subscription_status: 'active' })
            .eq('id', accountId);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        await upsertSubscriptionStatus(event.data.object);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await updateStatusByStripeCustomer(sub.customer, 'canceled');
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.customer) {
          await updateStatusByStripeCustomer(invoice.customer, 'past_due');
        }
        break;
      }
      default:
        break; // Every other event type is ignored on purpose.
    }
    res.json({ received: true });
  } catch (err) {
    // Full detail server-side only — same "unwrap" philosophy as
    // dashboard.js's error handling. Stripe just needs a 500 to retry.
    console.error(`[billing] webhook handler failed for ${event.type}:`, err.message);
    res.status(500).send('Webhook handler error');
  }
}

module.exports = { router, webhookHandler };
