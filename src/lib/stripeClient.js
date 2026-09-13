// Stripe client for Cornwall Radar's own subscription — a completely
// separate Stripe account/product from Spriggle's, per this project's
// "zero shared infrastructure" rule (see Cornwall-Radar-Spec.md §3).
//
// `stripe` is null until STRIPE_SECRET_KEY is set, so routes can return a
// clear "not configured" message instead of crashing — same pattern as
// every other optional integration in this project.
const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

module.exports = { stripe };
