const { stripe } = require('./stripeClient');

/**
 * Value-position reference: `.del` is never *called* here — it is configured
 * and returned. The scanner must still catch this site.
 */
function setupSubscriptionMock(subscriptionId, status) {
  stripe.subscriptions.del.mockResolvedValue({ id: subscriptionId, status });
  return stripe.subscriptions.del;
}

module.exports = { setupSubscriptionMock };
