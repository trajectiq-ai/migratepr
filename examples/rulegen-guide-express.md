# Express 5 migration guide (excerpt)

## Removed: app.del()
`app.del()` has been removed entirely, since it was a deprecated alias of `app.delete()` since Express 4.
Use `app.delete()` instead.

## Removed: `res.sendfile()`
The `res.sendfile()` method (lowercase "f") has been removed.
Use the camelCased version `res.sendFile()` instead.

## Changed: wildcard route syntax
Wildcard route patterns changed from `*` to a named wildcard: `app.get('*', ...)` becomes `app.get('/*splat', ...)`.

## Version
Express 5 requires Node.js 18 or later. The npm package `express` major version moved from 4 to 5.