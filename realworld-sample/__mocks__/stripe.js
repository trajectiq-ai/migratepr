/**
 * Jest manual mock for stripe (real jest.mock('stripe') support).
 *
 * `new Stripe(key, opts)` returns the shared `instance`, and the exported
 * constructor also exposes the same jest.fns so tests can configure either
 * via `require('stripe')` or through the app's client wrapper.
 */
const instance = {
  checkout: {
    sessions: {
      create: jest.fn(),
    },
  },
  subscriptions: {
    // Removed in stripe-node v13 → `cancel`.
    del: jest.fn(),
  },
};

const Stripe = jest.fn(() => instance);
Object.assign(Stripe, instance);

module.exports = Stripe;
