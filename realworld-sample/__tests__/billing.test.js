const { createCheckoutSession } = require('../src/checkout');
const { SubscriptionsService } = require('../src/subscriptions');
const { setupSubscriptionMock } = require('../src/subscriptionMockSetup');

// Manual mock (real jest.mock, no network).
jest.mock('stripe');

const stripe = require('stripe');

describe('checkout', () => {
  it('creates a checkout session through the wrapper', async () => {
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_123' });
    const id = await createCheckoutSession({
      priceCents: 2500,
      shippingRateId: 'sr_test_standard',
      email: 'buyer@example.com',
    });
    expect(id).toBe('cs_test_123');
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ shipping_rates: ['sr_test_standard'] }),
    );
  });
});

describe('subscriptions', () => {
  it('cancels a subscription via subscriptions.del', async () => {
    stripe.subscriptions.del.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    const svc = new SubscriptionsService();
    const status = await svc.cancel('sub_1');
    expect(status).toBe('canceled');
    expect(stripe.subscriptions.del).toHaveBeenCalledWith('sub_1');
  });

  it('wires the mock through the value-position helper', async () => {
    const del = setupSubscriptionMock('sub_2', 'canceled');
    await del('sub_2');
    expect(del).toHaveBeenCalledWith('sub_2');
  });
});
