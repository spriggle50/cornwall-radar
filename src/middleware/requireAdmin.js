// Gate for the logged-in admin panel (routes/admin.js) — a second way to do
// the exact same moderation as the emailed one-click links in business.js
// and reviews.js, for when Ady is signed in but doesn't have that
// particular email to hand (deleted, searched for and not found, wrong
// inbox, etc). There's no admin-role concept anywhere in this project's
// Supabase Auth (same reasoning as the emailed-link admin routes), so this
// reuses the one admin identity that's already configured — whoever's
// signed-in email matches ADMIN_ALERT_EMAIL, the same address the
// moderation alerts already go to — rather than adding a second one via a
// new column/role/env var.
//
// Must run AFTER requireAuth, since it reads req.user (set there). If
// ADMIN_ALERT_EMAIL isn't set, admin routes refuse everyone rather than
// falling back to "anyone signed in is an admin".
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL;

function requireAdmin(req, res, next) {
  const email = req.user && req.user.email;
  if (!ADMIN_ALERT_EMAIL || !email || email.toLowerCase() !== ADMIN_ALERT_EMAIL.toLowerCase()) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  next();
}

module.exports = { requireAdmin };
