const { stripe } = require('./stripeClient');

// Local alias — must be followed to the underlying call site.
const createCheckout = stripe.checkout.sessions.create;

/**
 * Creates a Checkout Session. Uses `shipping_rates` (removed in stripe-node
 * v13 → `shipping_options: [{ shipping_rate: id }]`).
 */
async function createCheckoutSession({ priceCents, shippingRateId, email }) {
  const session = await createCheckout({
    mode: 'payment',
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: priceCents,
          product_data: { name: 'Widget' },
        },
      },
    ],
    shipping_rates: [shippingRateId],
  });
  return session.id;
}

module.exports = { createCheckoutSession };
