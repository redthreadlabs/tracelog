/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Tests for the `transactionChannels` config option: routing transactions,
// their spans, and their breakdown metricsets to a named channel by
// transaction-name wildcard pattern.

const test = require('tape');

const Agent = require('../lib/agent');
const { CapturingTransport } = require('./_capturing_transport');
const { normalizeTransactionChannels } = require('../lib/config/normalizers');
const { MockLogger } = require('./_mock_logger');

const testAgentOpts = {
  serviceName: 'test-transaction-channels',
  cloudProvider: 'none',
  centralConfig: false,
  captureExceptions: false,
  metricsInterval: '0s',
  spanCompressionEnabled: false,
  logLevel: 'off',
  transport() {
    return new CapturingTransport();
  },
  transactionChannels: [
    { pattern: '* unknown route*', channel: 'unknown-route' },
  ],
};

test('normalizeTransactionChannels compiles rules and drops invalid ones', (t) => {
  const opts = {
    transactionChannels: [
      { pattern: '* unknown route*', channel: 'unknown-route' },
      { pattern: 'GET /noise*' }, // missing channel: dropped
      { channel: 'no-pattern' }, // missing pattern: dropped
      null, // dropped
      { pattern: 'POST /things', channel: 'things' },
    ],
  };
  normalizeTransactionChannels(opts, [], {}, new MockLogger());
  t.equal(opts.transactionChannelRules.length, 2, 'two valid rules compiled');
  t.equal(opts.transactionChannelRules[0].channel, 'unknown-route');
  t.ok(
    opts.transactionChannelRules[0].re.test('GET unknown route'),
    'pattern matches "GET unknown route"',
  );
  t.ok(
    opts.transactionChannelRules[0].re.test('GET unknown route (unnamed)'),
    'pattern matches "GET unknown route (unnamed)"',
  );
  t.notOk(
    opts.transactionChannelRules[0].re.test('GET /health/check'),
    'pattern does not match a real route',
  );
  t.end();
});

test('agent._channelForTransactionName resolves first matching rule', (t) => {
  const agent = new Agent().start(testAgentOpts);
  t.equal(
    agent._channelForTransactionName('GET unknown route'),
    'unknown-route',
  );
  t.equal(agent._channelForTransactionName('GET /real/route'), null);
  t.equal(agent._channelForTransactionName(undefined), null);
  agent.destroy();
  t.end();
});

test('matching transactions are routed to the named channel', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const t1 = agent.startTransaction('GET unknown route', 'request');
  t1.end();
  const t2 = agent.startTransaction('GET /real/route', 'request');
  t2.end();

  agent.flush(() => {
    const transport = agent._apmClient;
    t.equal(
      transport.transactions.length,
      1,
      'default channel got one transaction',
    );
    t.equal(transport.transactions[0].name, 'GET /real/route');
    const routed = transport.channels['unknown-route'];
    t.ok(routed, 'unknown-route channel exists');
    t.equal(routed.transactions.length, 1, 'channel got one transaction');
    t.equal(routed.transactions[0].name, 'GET unknown route');
    agent.destroy();
    t.end();
  });
});

test('spans follow their transaction to the named channel', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const t1 = agent.startTransaction('GET unknown route', 'request');
  const s1 = agent.startSpan('SELECT FROM foo', 'db', 'mysql');
  s1.end();
  t1.end();

  const t2 = agent.startTransaction('GET /real/route', 'request');
  const s2 = agent.startSpan('SELECT FROM bar', 'db', 'mysql');
  s2.end();
  t2.end();

  agent.flush(() => {
    const transport = agent._apmClient;
    t.equal(transport.spans.length, 1, 'default channel got one span');
    t.equal(transport.spans[0].name, 'SELECT FROM bar');
    const routed = transport.channels['unknown-route'];
    t.ok(routed, 'unknown-route channel exists');
    t.equal(routed.spans.length, 1, 'channel got one span');
    t.equal(routed.spans[0].name, 'SELECT FROM foo');
    agent.destroy();
    t.end();
  });
});

test('spans of transactions named only at end stay on the default channel', (t) => {
  // HTTP-framework transactions (e.g. Express) get their route name at
  // transaction.end(); until then the name getter falls back to
  // '<METHOD> unknown route (unnamed)'. Span routing must not use that
  // fallback, else every in-flight request's spans would match
  // unmatched-route rules and be diverted.
  const agent = new Agent().start(testAgentOpts);

  const t1 = agent.startTransaction(null, 'request');
  const s1 = agent.startSpan('redis-session-lookup', 'db', 'redis');
  s1.end(); // ends while the transaction is still unnamed
  t1.setDefaultName('GET unknown route');
  t1.end();

  agent.flush(() => {
    const transport = agent._apmClient;
    t.equal(transport.spans.length, 1, 'span stayed on the default channel');
    t.equal(transport.spans[0].name, 'redis-session-lookup');
    const routed = transport.channels['unknown-route'];
    t.ok(routed, 'unknown-route channel exists');
    t.equal(
      routed.transactions.length,
      1,
      'end-named transaction was still routed',
    );
    t.equal(routed.transactions[0].name, 'GET unknown route');
    t.equal(routed.spans.length, 0, 'no spans were routed');
    agent.destroy();
    t.end();
  });
});

test('breakdown metricsets follow their transaction to the named channel', (t) => {
  const agent = new Agent().start(
    Object.assign({}, testAgentOpts, {
      metricsInterval: '1s',
      breakdownMetrics: true,
    }),
  );

  const t1 = agent.startTransaction('GET unknown route', 'request');
  t1.end();
  const t2 = agent.startTransaction('GET /real/route', 'request');
  t2.end();

  // Breakdown metricsets are sent on the metrics interval (1s here); there
  // is no flush-now mechanism, so wait two intervals before asserting.
  setTimeout(() => {
    const transport = agent._apmClient;

    const defaultBreakdowns = transport.metricsets.filter(
      (ms) => ms.transaction,
    );
    t.ok(
      defaultBreakdowns.length > 0,
      'default channel got breakdown metricsets',
    );
    t.ok(
      defaultBreakdowns.every(
        (ms) => ms.transaction.name === 'GET /real/route',
      ),
      'all default-channel breakdowns are for the unrouted transaction',
    );

    const routed = transport.channels['unknown-route'];
    t.ok(routed, 'unknown-route channel exists');
    t.ok(
      routed.metricsets.length > 0,
      'channel got breakdown metricsets',
    );
    t.ok(
      routed.metricsets.every(
        (ms) => ms.transaction.name === 'GET unknown route',
      ),
      'all channel breakdowns are for the routed transaction',
    );

    agent.destroy();
    t.end();
  }, 2000);
});
