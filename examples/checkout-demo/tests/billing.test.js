const { createCheckoutSession, cancelSubscription } = require('../src/billing');

describe('billing', () => {
  it('creates a checkout session for the demo product', async () => {
    const result = await createCheckoutSession(2500, 'sr_test_standard');
    expect(result.totalCents).toBe(2500);
    expect(result.sessionId.startsWith('cs_')).toBe(true);
  });

  it('cancels a subscription', async () => {
    const status = await cancelSubscription('sub_test_123');
    expect(status).toBe('canceled');
  });
});
