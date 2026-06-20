/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// The client-ingest channel API: writeClientEvents / writeRecordOrigin forward
// the schema-0.4.0 record shapes as-is, and writeTransaction/writeSpan pass the
// new lifetime_id join key + context.labels through validation.

const test = require('tape');

const Agent = require('../lib/agent');
const { CapturingTransport } = require('./_capturing_transport');

const testAgentOpts = {
  serviceName: 'test-client-channel',
  cloudProvider: 'none',
  centralConfig: false,
  captureExceptions: false,
  metricsInterval: '0s',
  logLevel: 'off',
  transport() {
    return new CapturingTransport();
  },
};

const HEX16 = 'a'.repeat(16);
const HEX16B = 'b'.repeat(16);
const HEX32 = 'c'.repeat(32);

test('writeClientEvents forwards the new event shape as-is (labels/locale/lifetime_id, µs)', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeClientEvents([
    {
      type: 'auth',
      timestamp: 1700000000000000, // epoch µs, forwarded unchanged
      level: 'warn',
      message: 'login failed',
      locale: 'en-US',
      lifetime_id: HEX16,
      context: { labels: { attempt: 2, ok: false, who: 'x' }, user: { id: 'u1' } },
      tz_offset: -300,
      error: { message: 'bad creds', code: 401 },
    },
  ]);

  const evs = agent._apmClient.channels.client.events;
  t.equal(evs.length, 1, 'one event forwarded');
  const e = evs[0];
  t.equal(e.timestamp, 1700000000000000, 'µs timestamp preserved (no ×1000)');
  t.equal(e.level, 'warn');
  t.equal(e.locale, 'en-US');
  t.equal(e.lifetime_id, HEX16);
  t.deepEqual(e.context, { labels: { attempt: 2, ok: false, who: 'x' }, user: { id: 'u1' } }, 'labels + user under context');
  t.equal(e.error.code, '401', 'error code stringified');
  t.equal(e.params, undefined, 'no legacy params');
  t.equal(e.duration, undefined, 'events carry no duration');
  agent.destroy();
  t.end();
});

test('writeClientEvents defaults a bad level/type and skips non-objects', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeClientEvents([{ level: 'nonsense' }, null]);
  const evs = agent._apmClient.channels.client.events;
  t.equal(evs.length, 1, 'the null input is skipped');
  t.equal(evs[0].level, 'info', 'invalid level → info');
  t.equal(evs[0].type, 'client-log', 'missing type → client-log');
  agent.destroy();
  t.end();
});

test('writeRecordOrigin writes a metadata record carrying the RecordOrigin', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeRecordOrigin({
    lifetime_id: HEX16,
    service: { name: 'duiduidui-app', version: '2.6.0' },
    runtime: { name: 'react-native', version: '0.85' },
    os: { name: 'iOS', version: '18' },
    device: {
      model: 'iPhone15', brand: 'Apple', type: 'phone', year_class: 2022,
      screen: { width: 393, height: 852, pixel_ratio: 3 },
    },
    bogus: 'dropped',
  });

  const metas = agent._apmClient.channels.client.metadatas;
  t.equal(metas.length, 1, 'one metadata record written');
  const o = metas[0];
  t.equal(o.lifetime_id, HEX16, 'lifetime_id is the join key');
  t.deepEqual(o.service, { name: 'duiduidui-app', version: '2.6.0' });
  t.deepEqual(o.runtime, { name: 'react-native', version: '0.85' });
  t.equal(o.device.year_class, 2022, 'numeric device field preserved');
  t.deepEqual(o.device.screen, { width: 393, height: 852, pixel_ratio: 3 });
  t.equal(o.bogus, undefined, 'unknown fields stripped');
  agent.destroy();
  t.end();
});

test('writeRecordOrigin rejects a non-origin (no service/runtime → nothing written)', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeRecordOrigin({ junk: true });
  const metas = (agent._apmClient.channels.client || {}).metadatas || [];
  t.equal(metas.length, 0, 'an empty origin writes nothing');
  agent.destroy();
  t.end();
});

test('client transaction/span pass lifetime_id through and keep context.labels', (t) => {
  const agent = new Agent().start(testAgentOpts);
  const ch = agent.getChannel('client');
  ch.writeTransaction({
    id: HEX16, trace_id: HEX32, name: 'req', type: 'app',
    timestamp: 1700000000000000, duration: 12, outcome: 'success',
    lifetime_id: HEX16, context: { labels: { route: '/x' }, user: { id: 'u1' } },
  });
  ch.writeSpan({
    id: HEX16B, trace_id: HEX32, transaction_id: HEX16, parent_id: HEX16,
    name: 'db', type: 'db', timestamp: 1700000000000000, duration: 4, outcome: 'success',
    lifetime_id: HEX16, context: { labels: { rows: 3 } },
  });

  const tr = agent._apmClient.channels.client.transactions[0];
  const sp = agent._apmClient.channels.client.spans[0];
  t.equal(tr.lifetime_id, HEX16, 'transaction lifetime_id passes validation');
  t.deepEqual(tr.context.labels, { route: '/x' }, 'transaction labels survive (not tags)');
  t.deepEqual(tr.context.user, { id: 'u1' }, 'transaction user survives');
  t.equal(tr.context.tags, undefined, 'no legacy tags key');
  t.equal(sp.lifetime_id, HEX16, 'span lifetime_id passes validation');
  t.deepEqual(sp.context.labels, { rows: 3 }, 'span labels survive');
  agent.destroy();
  t.end();
});
