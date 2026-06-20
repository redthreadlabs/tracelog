/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Serialized records must not contain empty `{}` context placeholders:
// context members without content are omitted, and `context` itself is
// omitted when every member is empty.

const test = require('tape');

const Agent = require('../lib/agent');
const { CapturingTransport } = require('./_capturing_transport');

const testAgentOpts = {
  serviceName: 'test-empty-context',
  cloudProvider: 'none',
  centralConfig: false,
  captureExceptions: false,
  metricsInterval: '0s',
  logLevel: 'off',
  transport() {
    return new CapturingTransport();
  },
};

test('a bare sampled transaction serializes no context at all', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const trans = agent.startTransaction('bare', 'custom');
  trans.end();

  agent.flush(() => {
    const payload = agent._apmClient.transactions[0];
    t.ok(payload.sampled, 'transaction is sampled');
    t.equal(payload.context, undefined, 'context omitted entirely');
    agent.destroy();
    t.end();
  });
});

test('a transaction with labels serializes only context.labels', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const trans = agent.startTransaction('labeled', 'custom');
  trans.addLabels({ user_id: 'u1' });
  trans.end();

  agent.flush(() => {
    const ctx = agent._apmClient.transactions[0].context;
    t.deepEqual(ctx.labels, { user_id: 'u1' }, 'labels present');
    t.equal(ctx.user, undefined, 'no empty user');
    t.equal(ctx.custom, undefined, 'no empty custom');
    t.equal(ctx.service, undefined, 'no empty service');
    t.equal(ctx.cloud, undefined, 'no empty cloud');
    t.equal(ctx.message, undefined, 'no empty message');
    agent.destroy();
    t.end();
  });
});

test('a transaction with a user serializes only context.user', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const trans = agent.startTransaction('with-user', 'custom');
  trans.setUserContext({ id: 'u-42' });
  trans.end();

  agent.flush(() => {
    const ctx = agent._apmClient.transactions[0].context;
    t.deepEqual(ctx.user, { id: 'u-42' }, 'user present');
    t.equal(ctx.labels, undefined, 'no empty labels');
    agent.destroy();
    t.end();
  });
});

test('a bare captured error serializes no context at all', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.captureError(new Error('bare failure'), () => {
    const payload = agent._apmClient.errors[0];
    t.ok(payload.exception, 'exception captured');
    t.equal(payload.context, undefined, 'context omitted entirely');
    agent.destroy();
    t.end();
  });
});

test('an error with labels serializes only context.labels', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.captureError(
    new Error('labeled failure'),
    { labels: { region: 'us-east-1' } },
    () => {
      const ctx = agent._apmClient.errors[0].context;
      t.deepEqual(ctx.labels, { region: 'us-east-1' }, 'labels present');
      t.equal(ctx.user, undefined, 'no empty user');
      t.equal(ctx.custom, undefined, 'no empty custom');
      agent.destroy();
      t.end();
    },
  );
});

test('an error inside a transaction inherits only populated members', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const trans = agent.startTransaction('failing', 'custom');
  trans.setUserContext({ id: 'u-7' });
  agent.captureError(new Error('inherits user'), () => {
    const ctx = agent._apmClient.errors[0].context;
    t.deepEqual(ctx.user, { id: 'u-7' }, 'user inherited from transaction');
    t.equal(ctx.labels, undefined, 'no empty labels');
    t.equal(ctx.custom, undefined, 'no empty custom');
    trans.end();
    agent.destroy();
    t.end();
  });
});
