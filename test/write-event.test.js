/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Tests for the agent's custom-event API (`writeEvent`/`writeEvents` and the
// channel-routed equivalents): error extraction, timestamp serialization
// units, level defaulting, and trace correlation.

const test = require('tape');

const Agent = require('../lib/agent');
const { CapturingTransport } = require('./_capturing_transport');

const testAgentOpts = {
  serviceName: 'test-write-event',
  cloudProvider: 'none',
  centralConfig: false,
  captureExceptions: false,
  metricsInterval: '0s',
  logLevel: 'off',
  transport() {
    return new CapturingTransport();
  },
};

// --- error extraction ---

test('writeEvent extracts message/type/code/stack from an Error instance', (t) => {
  const agent = new Agent().start(testAgentOpts);
  const err = new Error('boom');
  err.code = 'EBOOM';

  agent.writeEvent('thing-failed', { error: err });

  const ev = agent._apmClient.events[0];
  t.equal(ev.error.message, 'boom');
  t.equal(ev.error.type, 'Error');
  t.equal(ev.error.code, 'EBOOM');
  t.ok(ev.error.stack, 'stack captured');
  agent.destroy();
  t.end();
});

test('writeEvent preserves the message of an error-like plain object', (t) => {
  // Errors that crossed a process boundary (e.g. relayed client errors,
  // ShareDB op errors) arrive as plain objects. These must not be
  // stringified to '[object Object]'.
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('op-failed', {
    error: { message: 'doc not found', code: 4017, stack: 'fake stack' },
  });

  const ev = agent._apmClient.events[0];
  t.equal(ev.error.message, 'doc not found', 'plain-object message survives');
  t.equal(ev.error.code, '4017', 'code stringified');
  t.equal(ev.error.stack, 'fake stack');
  agent.destroy();
  t.end();
});

test('writeEvent uses the type field of an error-like plain object', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('op-failed', {
    error: { message: 'nope', type: 'ShareDBError' },
  });

  t.equal(agent._apmClient.events[0].error.type, 'ShareDBError');
  agent.destroy();
  t.end();
});

test('writeEvent falls back to bounded JSON for message-less objects', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('op-failed', { error: { code: 4017, op: 'submit' } });

  const ev = agent._apmClient.events[0];
  t.equal(ev.error.message, '{"code":4017,"op":"submit"}');
  t.notEqual(ev.error.message, '[object Object]');
  t.equal(ev.error.code, '4017');
  agent.destroy();
  t.end();
});

test('writeEvent bounds huge JSON fallbacks to ~500 chars', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('op-failed', { error: { blob: 'x'.repeat(5000) } });

  const msg = agent._apmClient.events[0].error.message;
  t.ok(msg.length <= 501, `bounded (got ${msg.length})`);
  agent.destroy();
  t.end();
});

test('writeEvent falls back to a key listing when JSON.stringify fails', (t) => {
  const agent = new Agent().start(testAgentOpts);
  const circular = { code: 1 };
  circular.self = circular;

  agent.writeEvent('op-failed', { error: circular });

  t.equal(
    agent._apmClient.events[0].error.message,
    '[object with keys: code, self]',
  );
  agent.destroy();
  t.end();
});

test('writeEvent passes string errors through', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('op-failed', { error: 'plain string failure' });

  t.equal(agent._apmClient.events[0].error.message, 'plain string failure');
  agent.destroy();
  t.end();
});

test('writeEvent with an error does NOT also emit an error record', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('op-failed', { error: new Error('boom') });

  // The old behavior also called writeError (via setImmediate); give that
  // path time to fire if it were still present.
  setTimeout(() => {
    t.equal(agent._apmClient.events.length, 1, 'one event');
    t.equal(agent._apmClient.errors.length, 0, 'no error record side effect');
    agent.destroy();
    t.end();
  }, 100);
});

test('channel writeEvent with an error does NOT emit an error record', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.getChannel('client').writeEvent('op-failed', {
    error: { message: 'relayed failure', code: 7 },
  });

  setTimeout(() => {
    const routed = agent._apmClient.channels['client'];
    t.equal(routed.events.length, 1, 'one event on the channel');
    t.equal(routed.events[0].error.message, 'relayed failure');
    t.equal(agent._apmClient.errors.length, 0, 'no error record side effect');
    agent.destroy();
    t.end();
  }, 100);
});

// --- timestamp serialization ---

test('writeEvent serializes a provided epoch-ms timestamp as epoch-µs', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('tick', { timestamp: 1781127624588 });

  t.equal(agent._apmClient.events[0].timestamp, 1781127624588 * 1000);
  agent.destroy();
  t.end();
});

test('writeEvent defaults the timestamp to now, in epoch-µs', (t) => {
  const agent = new Agent().start(testAgentOpts);
  const beforeUs = Date.now() * 1000;

  agent.writeEvent('tick', {});

  const afterUs = Date.now() * 1000;
  const ts = agent._apmClient.events[0].timestamp;
  t.ok(ts >= beforeUs && ts <= afterUs, `µs-scale default (got ${ts})`);
  agent.destroy();
  t.end();
});

test('writeEvents serializes batch timestamps as epoch-µs', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvents([
    { type: 'a', timestamp: 1000 },
    { type: 'b', timestamp: 2000 },
  ]);

  t.equal(agent._apmClient.events[0].timestamp, 1000000);
  t.equal(agent._apmClient.events[1].timestamp, 2000000);
  agent.destroy();
  t.end();
});

// --- level defaulting ---

test('writeEvent defaults level to info', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('tick', {});
  agent.writeEvent('boom', { level: 'error' });

  t.equal(agent._apmClient.events[0].level, 'info', 'defaulted');
  t.equal(agent._apmClient.events[1].level, 'error', 'explicit level kept');
  agent.destroy();
  t.end();
});

// --- trace correlation ---

test('writeEvent inside a transaction is stamped with trace context', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const trans = agent.startTransaction('GET /thing', 'request');
  agent.writeEvent('doc-loaded', { message: 'loaded' });
  trans.end();

  const ev = agent._apmClient.events[0];
  t.equal(ev.trace_id, trans.traceId, 'trace_id stamped');
  t.equal(ev.transaction_id, trans.id, 'transaction_id stamped');
  agent.destroy();
  t.end();
});

test('writeEvent outside a transaction has no trace context', (t) => {
  const agent = new Agent().start(testAgentOpts);

  agent.writeEvent('startup', { message: 'service initialized' });

  const ev = agent._apmClient.events[0];
  t.equal(ev.trace_id, undefined, 'no trace_id');
  t.equal(ev.transaction_id, undefined, 'no transaction_id');
  agent.destroy();
  t.end();
});

test('channel writeEvent inside a transaction is stamped with trace context', (t) => {
  const agent = new Agent().start(testAgentOpts);

  const trans = agent.startTransaction('POST /logs', 'request');
  agent.getChannel('client').writeEvent('relay-note', {});
  trans.end();

  const ev = agent._apmClient.channels['client'].events[0];
  t.equal(ev.trace_id, trans.traceId);
  t.equal(ev.transaction_id, trans.id);
  agent.destroy();
  t.end();
});

test('batch writeEvents are never stamped with trace context', (t) => {
  // Batched events originate on remote clients; the transaction that
  // relayed them is not their trace.
  const agent = new Agent().start(testAgentOpts);

  const trans = agent.startTransaction('POST /logs', 'request');
  agent.writeEvents([{ type: 'remote-a' }, { type: 'remote-b' }]);
  agent.getChannel('client').writeEvents([{ type: 'remote-c' }]);
  trans.end();

  for (const ev of agent._apmClient.events) {
    t.equal(ev.trace_id, undefined, `${ev.type}: no trace_id`);
  }
  const routed = agent._apmClient.channels['client'].events;
  t.equal(routed[0].trace_id, undefined, 'channel batch: no trace_id');
  agent.destroy();
  t.end();
});
