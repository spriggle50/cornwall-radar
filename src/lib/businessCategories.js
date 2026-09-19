// Single source of truth for the fixed set of business categories a
// listing can pick from. Before this, category was free text, so the
// same trade could show up as "Cafe", "Café" and "Coffee shop" — fine to
// display, but useless to filter or browse by. Both the create/edit
// listing form and the directory's filter dropdown build their options
// from this same list (served publicly via GET /api/directory/categories
// in routes/directory.js), and routes/business.js validates new/edited
// listings against it, so a listing can never end up with a category
// that isn't in this list.
//
// Adding a category later is safe and non-breaking (existing listings
// keep whatever they have); removing or renaming one is not — any
// listing already saved under the old value keeps it until its owner
// edits and re-saves the listing, so avoid renaming entries once
// businesses have started using this list for real.
const BUSINESS_CATEGORIES = [
  'Food & Drink',
  'Pubs & Bars',
  'Shops & Retail',
  'Trades & Home Services',
  'Beauty & Hair',
  'Health & Fitness',
  'Professional Services',
  'Automotive',
  'Cleaning Services',
  'Childcare & Education',
  'Pet Services',
  'Farm Shops & Local Produce',
  'Accommodation',
  'Arts, Crafts & Gifts',
  'Events & Entertainment',
  'Photography & Media',
  'IT & Tech Services',
  'Other',
];

module.exports = { BUSINESS_CATEGORIES };
