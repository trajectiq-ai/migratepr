import { MigrationTrack } from '../types';

/**
 * Structured rule library for Stripe, derived from Stripe's official SDK
 * migration guides and API changelog. Each rule is deliberately narrow:
 * deterministic where possible, and always tied to its official source URL.
 *
 * This registry is the compounding asset: every new vendor release adds a
 * track, every merged migration PR improves the rules.
 */

export const STRIPE_TRACKS: MigrationTrack[] = [
  {
    id: 'stripe-v12-to-v13',
    vendor: 'stripe',
    sdkModule: 'stripe',
    sdkFrom: 12,
    sdkTo: 13,
    apiFrom: '2022-11-15',
    apiTo: '2023-08-16',
    guideUrls: [
      'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v13',
      'https://docs.stripe.com/upgrades',
    ],
    rules: [
      {
        id: 'stripe-v12-to-v13:subscriptions-del-cancel',
        kind: 'method-rename',
        resource: 'subscriptions',
        from: 'del',
        to: 'cancel',
        summary:
          'The deprecated `del` method on Subscriptions was removed in stripe-node v13; use `cancel` (available since v9.14.0).',
        guideUrl: 'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v13',
        risk: 'mechanical',
      },
      {
        id: 'stripe-v12-to-v13:checkout-shipping-options',
        kind: 'param-rename',
        resource: 'checkout.sessions',
        method: 'create',
        from: 'shipping_rates',
        to: 'shipping_options',
        wrapTemplate: '{ shipping_rate: $0 }',
        summary:
          '`shipping_rates` was removed from Checkout Session creation in v13; use `shipping_options`, whose items wrap each rate id in an object (`{ shipping_rate: id }`).',
        guideUrl: 'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v13',
        risk: 'review-recommended',
      },
      {
        id: 'stripe-v12-to-v13:api-version-2023-08-16',
        kind: 'api-version',
        from: '2022-11-15',
        to: '2023-08-16',
        summary: 'Pin the Stripe client to the new API version 2023-08-16.',
        guideUrl: 'https://docs.stripe.com/upgrades',
        risk: 'mechanical',
      },
      {
        id: 'stripe-v12-to-v13:mock-subscriptions-del-cancel',
        kind: 'mock-method-key',
        resource: 'subscriptions',
        from: 'del',
        to: 'cancel',
        summary:
          'Test mocks imitating the SDK must drop `subscriptions.del` too, or suites fail after migration.',
        guideUrl: 'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v13',
        risk: 'mechanical',
      },
      {
        id: 'stripe-v12-to-v13:sdk-bump-v13',
        kind: 'sdk-bump',
        packageName: 'stripe',
        to: '^13.11.0',
        summary: 'Bump the stripe-node dependency to ^13.',
        guideUrl: 'https://www.npmjs.com/package/stripe',
        risk: 'mechanical',
      },
    ],
  },
  {
    // Second track kept in the registry to demonstrate the rule library:
    // Basil (2025-03-31.basil) replaced the Upcoming Invoice API.
    id: 'stripe-v17-to-v18',
    vendor: 'stripe',
    sdkModule: 'stripe',
    sdkFrom: 17,
    sdkTo: 18,
    apiFrom: '2024-12-18.acacia',
    apiTo: '2025-03-31.basil',
    guideUrls: [
      'https://docs.stripe.com/changelog/basil',
      'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v18',
    ],
    rules: [
      {
        id: 'stripe-v17-to-v18:invoices-create-preview',
        kind: 'method-rename',
        resource: 'invoices',
        from: 'retrieveUpcoming',
        to: 'createPreview',
        summary:
          'The Upcoming Invoice API methods were replaced by the Create Preview Invoice API in stripe-node v18; `invoices.retrieveUpcoming(...)` becomes `invoices.createPreview(...)` (parameter semantics changed slightly — review the call).',
        guideUrl: 'https://docs.stripe.com/changelog/basil',
        risk: 'review-recommended',
      },
      {
        id: 'stripe-v17-to-v18:api-version-basil',
        kind: 'api-version',
        from: '2024-12-18.acacia',
        to: '2025-03-31.basil',
        summary: 'Pin the Stripe client to the new API version 2025-03-31.basil.',
        guideUrl: 'https://docs.stripe.com/upgrades',
        risk: 'mechanical',
      },
      {
        id: 'stripe-v17-to-v18:sdk-bump-v18',
        kind: 'sdk-bump',
        packageName: 'stripe',
        to: '^18.0.0',
        summary: 'Bump the stripe-node dependency to ^18.',
        guideUrl: 'https://www.npmjs.com/package/stripe',
        risk: 'mechanical',
      },
    ],
  },
];
