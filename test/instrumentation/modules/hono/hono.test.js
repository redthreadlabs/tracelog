/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Hono instrumentation: naming transactions after the matched route (through
// mounted sub-apps and `basePath()` clones), folding unmatched requests into
// "unknown route", capturing handler errors while leaving client-side
// HTTPExceptions alone, and capturing the body the handler itself parsed.
//
// ONE agent for the whole file: `hono` is patched when it is first required
// and then served from the module cache, so its middleware is bound to
// whichever agent was running at that moment. A per-test agent would leave
// every test after the first one wired to a destroyed agent. Each test clears
// the transport instead.

const test = require('tape');

const Agent = require('../../../../lib/agent');
const { CapturingTransport } = require('../../../_capturing_transport');

const agent = new Agent().start({
  serviceName: 'test-hono',
  cloudProvider: 'none',
  centralConfig: false,
  captureExceptions: false,
  metricsInterval: '0s',
  spanCompressionEnabled: false,
  logLevel: 'off',
  captureBody: 'all',
  sanitizeFieldNames: ['password'],
  transport() {
    return new CapturingTransport();
  },
});

// Required after the agent starts, so the module hooks are in place.
const { Hono } = require('hono');
const { HTTPException } = require('hono/http-exception');
const { serve } = require('@hono/node-server');

test.onFinish(() => agent.destroy());

/** Resolve once the transport has captured `n` transactions (or time out). */
async function waitForTransactions(agent, n, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (agent._apmClient.transactions.length < n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return agent._apmClient.transactions;
}

/** Resolve once the transport has captured `n` errors (or time out).
 * captureError parses stack traces asynchronously, so an error lands a beat
 * after the transaction it happened in. */
async function waitForErrors(agent, n, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (agent._apmClient.errors.length < n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return agent._apmClient.errors;
}

/** Serve `app` on an ephemeral port; returns { base, close }. */
function serveApp(serve, app) {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({
        base: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

const byName = (transactions) => transactions.map((t) => t.name).sort();

/** GET/POST and read the body — an unconsumed body keeps its socket open. */
async function call(url, opts) {
  const res = await fetch(url, opts);
  await res.text();
  return res;
}

test('hono: transaction names come from the matched route', async (t) => {
  agent._apmClient.clear();

  const objects = new Hono();
  objects.get('/:id', (c) => c.text('one'));
  objects.put('/:id/blob', (c) => c.text('stored'));

  const app = new Hono();
  app.get('/health', (c) => c.text('ok'));
  app.get('/users/:name', (c) => c.text('user'));
  app.route('/objects', objects);

  const { base, close } = await serveApp(serve, app);
  await call(`${base}/health`);
  await call(`${base}/users/jane`);
  await call(`${base}/objects/abc`);
  await call(`${base}/objects/abc/blob`, { method: 'PUT', body: 'x' });

  const transactions = await waitForTransactions(agent, 4);
  t.deepEqual(
    byName(transactions),
    [
      'GET /health',
      'GET /objects/:id',
      'GET /users/:name',
      'PUT /objects/:id/blob',
    ],
    'each transaction is named for its route pattern, sub-apps included',
  );
  t.equal(transactions[0].type, 'request', 'transaction.type');
  t.equal(
    agent._conf.frameworkName,
    'hono',
    'the framework is reported as hono',
  );

  await close();
  t.end();
});

test('hono: unmatched requests fold into "unknown route"', async (t) => {
  agent._apmClient.clear();

  const app = new Hono();
  app.get('/known', (c) => c.text('ok'));
  // A route that legitimately answers 404 must keep its own name.
  app.get('/missing-thing', (c) => c.notFound());

  const { base, close } = await serveApp(serve, app);
  await call(`${base}/wp-login.php`);
  await call(`${base}/.env`);
  await call(`${base}/missing-thing`);

  const transactions = await waitForTransactions(agent, 3);
  t.deepEqual(
    byName(transactions),
    ['GET /missing-thing', 'GET unknown route', 'GET unknown route'],
    'scanner noise folds into one name; a real 404 route keeps its own',
  );

  await close();
  t.end();
});

test('hono: a "basePath()" clone is still traced', async (t) => {
  agent._apmClient.clear();

  // basePath() clones through Hono's internal class, bypassing the patched
  // constructor — but the clone shares the router the middleware went into.
  const app = new Hono().basePath('/api');
  app.get('/things/:id', (c) => c.text('thing'));

  const { base, close } = await serveApp(serve, app);
  await call(`${base}/api/things/7`);

  const transactions = await waitForTransactions(agent, 1);
  t.equal(
    transactions[0] && transactions[0].name,
    'GET /api/things/:id',
    'the clone names transactions from the merged route',
  );

  await close();
  t.end();
});

test('hono: handler errors are captured, client HTTPExceptions are not', async (t) => {
  agent._apmClient.clear();

  const app = new Hono();
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.get('/unauthorized', () => {
    throw new HTTPException(401, { message: 'nope' });
  });
  app.get('/upstream', () => {
    throw new HTTPException(502, { message: 'bad gateway' });
  });

  const { base, close } = await serveApp(serve, app);
  await call(`${base}/boom`);
  await call(`${base}/unauthorized`);
  await call(`${base}/upstream`);

  await waitForTransactions(agent, 3);
  const errors = await waitForErrors(agent, 2);
  const messages = errors
    .map((e) => e.exception && e.exception.message)
    .sort();
  t.deepEqual(
    messages,
    ['bad gateway', 'kaboom'],
    'the thrown Error and the 5xx HTTPException are captured; the 401 is not',
  );
  t.equal(
    errors[0].context && errors[0].context.request.method,
    'GET',
    'the captured error carries request context',
  );
  t.equal(
    agent._apmClient.transactions.find((tr) => tr.name === 'GET /boom')
      .outcome,
    'failure',
    'the failed transaction keeps its route name',
  );

  await close();
  t.end();
});

test('hono: the body the handler parsed is captured and redacted', async (t) => {
  agent._apmClient.clear();

  const app = new Hono();
  app.post('/login', async (c) => {
    await c.req.json(); // the handler reads it; the agent reuses that read
    return c.text('ok');
  });
  app.post('/ignores-body', (c) => c.text('ok'));

  const { base, close } = await serveApp(serve, app);
  const send = (path) =>
    call(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'jane', password: 'hunter2' }),
    });
  await send('/login');
  await send('/ignores-body');

  const transactions = await waitForTransactions(agent, 2);
  const parsed = transactions.find((tr) => tr.name === 'POST /login');
  const unparsed = transactions.find((tr) => tr.name === 'POST /ignores-body');
  t.deepEqual(
    parsed.context.request.body,
    { user: 'jane', password: '[REDACTED]' },
    'the parsed body is captured, deep-redacted against sanitizeFieldNames',
  );
  t.equal(
    unparsed.context.request.body,
    undefined,
    'a handler that never reads its body contributes no body',
  );

  await close();
  t.end();
});
