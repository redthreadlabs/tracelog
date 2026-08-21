/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Instrumentation of Hono (https://hono.dev).
//
// On Node, Hono is served by @hono/node-server, i.e. by `node:http`, so the
// HTTP instrumentation already opens a transaction for every request. What
// Hono itself has to supply is what only the framework knows:
//
//   1. the ROUTE the request matched, so the transaction is named
//      "PUT /objects/:owner/:slug" instead of one name per distinct URL;
//   2. the ERROR a handler threw, which Hono hands to its own error handler
//      rather than letting it reach the HTTP layer;
//   3. the BODY the handler parsed, for `captureBody`.
//
// All three are read from the request context by a single middleware that the
// patched constructor registers on every app, after `await next()` — the point
// where the route is known and the response exists but nothing has been
// written to the socket yet.
//
// Note that a try/catch around `await next()` would NOT see handler errors:
// Hono's compose() catches at the frame that throws and invokes the app's
// error handler there, so the rejection never propagates outward. It does
// assign the error to `c.error` first, which is what this reads.

const semver = require('semver');

// Marks a request context whose outermost tracing middleware has already
// claimed it. An app mounted with `app.route(path, subApp)` contributes its
// own copy of the middleware to the parent's router, so without this the
// middleware runs once per level of nesting.
const CLAIMED = Symbol('tracelogHonoClaimed');

/**
 * The raw `node:http` request, when Hono is running under @hono/node-server.
 * Absent on other runtimes (Bun, Deno, workers), where there is no Node
 * request to hang context off of.
 */
function incomingOf(c) {
  const incoming = c.env && c.env.incoming;
  return incoming && typeof incoming === 'object' ? incoming : undefined;
}

/**
 * True when nothing concrete handled the request: every route that matched is
 * a wildcard middleware (this instrumentation's own included) and the result
 * is a 404. Such requests are overwhelmingly internet-scanner noise on a
 * public server (/.env, /wp-login.php, ...), and one transaction name per
 * probed URL would swamp the per-endpoint statistics. Naming them all
 * "GET unknown route" keeps them countable, and divertible wholesale with
 * `transactionChannels: [{ pattern: '* unknown route*', channel: '...' }]`.
 *
 * Requiring the 404 keeps a real `app.all('/files/*', ...)` handler — which
 * looks like middleware in `matchedRoutes` — correctly named whenever it
 * actually serves something.
 */
function isUnknownRoute(c) {
  if (!c.res || c.res.status !== 404) {
    return false;
  }
  const matched = c.req.matchedRoutes;
  if (!Array.isArray(matched) || matched.length === 0) {
    return true;
  }
  return matched.every(
    (r) =>
      r &&
      r.method === 'ALL' &&
      typeof r.path === 'string' &&
      r.path.endsWith('*'),
  );
}

function transactionNameFrom(c) {
  const method = c.req.method;
  if (isUnknownRoute(c)) {
    return method + ' unknown route';
  }
  // `routePath` is the pattern the matched handler was registered with,
  // already merged with the mount prefix for sub-apps, e.g. "/objects/:id".
  const routePath = c.req.routePath;
  return routePath ? method + ' ' + routePath : method + ' unknown route';
}

/**
 * Hono's HTTPException is control flow, not failure: `throw new
 * HTTPException(401)` is the idiomatic way to answer a request, and reporting
 * every one as an APM error would bury the real ones. Server-side statuses
 * (>=500) are still reported. Duck-typed because HTTPException does not set
 * a distinguishing `name` and is published from a subpath this file should
 * not have to resolve.
 */
function isClientHttpException(err) {
  return (
    typeof err.getResponse === 'function' &&
    typeof err.status === 'number' &&
    err.status < 500
  );
}

/**
 * Hand the body the handler already parsed to the request-context builder,
 * which redacts it against `sanitizeFieldNames` and honours `captureBody`.
 *
 * Hono caches body reads as PROMISES on `c.req.bodyCache`; the cached one is
 * already settled by the time a handler has run, so attaching a continuation
 * costs a microtask and never blocks the response. The transaction is not
 * serialized until the response finishes — an I/O event, always later than a
 * microtask — so the body is in place in time.
 *
 * Nothing is read that the app did not read itself: an endpoint that never
 * touches its body has an empty cache and contributes nothing here.
 */
function attachParsedBody(c) {
  const incoming = incomingOf(c);
  if (!incoming || incoming.body !== undefined) {
    return;
  }
  const cache = c.req.bodyCache;
  if (!cache) {
    return;
  }
  // Prefer an already-structured parse; `text` is redacted by content-type.
  const cached =
    cache.json !== undefined
      ? cache.json
      : cache.form !== undefined
      ? cache.form
      : cache.text;
  if (cached === undefined) {
    return;
  }
  Promise.resolve(cached).then(
    (body) => {
      if (body !== undefined && incoming.body === undefined) {
        incoming.body = body;
      }
    },
    () => {}, // a body the app failed to parse is not this agent's problem
  );
}

module.exports = function (modExports, agent, { version, enabled }) {
  if (!enabled) {
    return modExports;
  }

  if (!semver.satisfies(version, '>=4.0.0 <5.0.0', { includePrerelease: true })) {
    agent.logger.debug(
      'cannot instrument hono version %s, skipping hono instrumentation',
      version,
    );
    return modExports;
  }

  const OrigHono = modExports && modExports.Hono;
  if (typeof OrigHono !== 'function') {
    agent.logger.debug(
      'hono module does not export `Hono`, skipping hono instrumentation',
    );
    return modExports;
  }

  agent.setFramework({ name: 'hono', version, overwrite: false });
  agent.logger.debug('wrapping hono.Hono');

  async function tracingMiddleware(c, next) {
    if (c[CLAIMED]) {
      await next();
      return;
    }
    c[CLAIMED] = true;

    await next();

    try {
      agent._instrumentation.setDefaultTransactionName(transactionNameFrom(c));

      // compose() assigns the thrown error here before delegating to the
      // app's error handler.
      const err = c.error;
      if (err && !isClientHttpException(err)) {
        agent.captureError(err, { request: incomingOf(c) });
      }

      attachParsedBody(c);
    } catch (instrErr) {
      // Instrumentation must never break the app it observes.
      agent.logger.debug(
        'hono instrumentation error: %s',
        instrErr && instrErr.message,
      );
    }
  }

  class Hono extends OrigHono {
    constructor(...args) {
      super(...args);
      // Registered first, so it wraps every user middleware and handler.
      //
      // `basePath()` clones an app through Hono's internal class rather than
      // `this.constructor`, so the clone never runs this constructor — but a
      // clone shares the original's router and routes, into which this
      // middleware has already been registered, so requests through it are
      // still traced.
      this.use('*', tracingMiddleware);
    }
  }

  // Under IITM the namespace object is writable, so patch it in place and
  // preserve object identity for anything already holding a reference. The
  // CommonJS build exports `Hono` as a non-configurable getter, where the
  // assignment is a silent no-op (or a throw under strict mode) — detect that
  // and hand back a copy with the class swapped instead.
  try {
    modExports.Hono = Hono;
    if (modExports.Hono === Hono) {
      return modExports;
    }
  } catch (_readOnly) {
    // fall through to the copy
  }
  const copy = {};
  for (const key of Object.keys(modExports)) {
    copy[key] = key === 'Hono' ? Hono : modExports[key];
  }
  return copy;
};
