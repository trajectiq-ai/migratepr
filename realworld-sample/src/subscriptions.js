const { stripe } = require('./stripeClient');

class SubscriptionsService {
  constructor(client = stripe) {
    this.client = client;
  }

  async cancel(subscriptionId) {
    // `subscriptions.del` was removed in stripe-node v13 → `cancel`
    const sub = await this.client.subscriptions.del(subscriptionId);
    return sub.status;
  }
}

module.exports = { SubscriptionsService };
