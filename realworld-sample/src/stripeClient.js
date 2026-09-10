const Stripe = require('stripe');

/**
 * Central Stripe client wrapper — the pattern nearly every real codebase has.
 * Every other file goes through this module, never straight to the SDK.
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  // Pinned to the v12 API — upgrading to v13 requires updating this pin.
  apiVersion: '2022-11-15',
});

module.exports = { stripe };
