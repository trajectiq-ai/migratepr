import { MigrationTrack } from '../types';

/**
 * Express v4 → v5 track, derived from the official migration guide
 * (https://expressjs.com/en/guide/migrating-5.html).
 *
 * Express 5 is a real breaking-major: `app.del` was removed, wildcard route
 * syntax changed (`*` → `/*splat`), and several APIs were dropped. The
 * deterministic rules cover what an AST scanner can prove; the rest (route
 * string rewrites, `req.param` removal) are flagged for review so no change
 * is guessed.
 */
export const EXPRESS_TRACKS: MigrationTrack[] = [
  {
    id: 'express-v4-to-v5',
    vendor: 'express',
    sdkModule: 'express',
    sdkFrom: 4,
    sdkTo: 5,
    apiFrom: '4.x',
    apiTo: '5.x',
    guideUrls: ['https://expressjs.com/en/guide/migrating-5.html'],
    rules: [
      {
        id: 'express-v4-to-v5:app-del-delete',
        kind: 'method-rename',
        resource: '',
        from: 'del',
        to: 'delete',
        summary:
          '`app.del()` was removed in Express 5 — it was a deprecated alias of `app.delete()`.',
        guideUrl: 'https://expressjs.com/en/guide/migrating-5.html',
        guideExcerpt:
          'Removed: app.del(). Use app.delete() instead. app.del has been removed entirely, since it was a deprecated alias of app.delete() since Express 4.',
        risk: 'mechanical',
      },
      {
        id: 'express-v4-to-v5:mock-app-del-delete',
        kind: 'mock-method-key',
        resource: '',
        from: 'del',
        to: 'delete',
        summary:
          'Test doubles imitating an Express app must drop `del` too, or suites fail after migration.',
        guideUrl: 'https://expressjs.com/en/guide/migrating-5.html',
        risk: 'mechanical',
      },
      {
        id: 'express-v4-to-v5:sdk-bump-v5',
        kind: 'sdk-bump',
        packageName: 'express',
        to: '^5.0.0',
        summary: 'Bump the express dependency to ^5.',
        guideUrl: 'https://www.npmjs.com/package/express',
        risk: 'mechanical',
      },
    ],
  },
];