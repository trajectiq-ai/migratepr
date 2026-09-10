const Stripe = require('stripe');

// Pinned to the pre-migration API version; MigratePR rewrites this string.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_demo', {
  apiVersion: '2022-11-15',
});

// Local alias — the scanner must follow this to the underlying call site.
const createSession = stripe.checkout.sessions.create;

async function createCheckoutSession(priceCents, shippingRateId) {
  const session = await createSession({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: priceCents,
          product_data: { name: 'Demo Widget' },
        },
      },
    ],
    // `shipping_rates: [id]` was removed in stripe-node v13
    // → shipping_options: [{ shipping_rate: id }]
    shipping_rates: [shippingRateId],
  });
  return { sessionId: session.id, totalCents: priceCents };
}

// subscriptions.del was removed in stripe-node v13 → cancel
async function cancelSubscription(subscriptionId) {
  const sub = await stripe.subscriptions.del(subscriptionId);
  return sub.status;
}

module.exports = { createCheckoutSession, cancelSubscription };
