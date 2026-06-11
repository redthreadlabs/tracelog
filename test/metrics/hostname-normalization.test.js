/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Metricset `tags.hostname` must be normalized the same way as the host in
// S3 keys (EC2-internal names become the dotted IP), so a viewer can
// correlate metrics with key-derived hosts using one rule.

const test = require('tape');

const Agent = require('../../lib/agent');
const { CapturingTransport } = require('../_capturing_transport');

test('metricset tags.hostname is normalized like the S3 key host', (t) => {
  const agent = new Agent().start({
    serviceName: 'test-metrics-hostname',
    hostname: 'ip-172-31-27-225.ec2.internal',
    cloudProvider: 'none',
    centralConfig: false,
    captureExceptions: false,
    metricsInterval: '1s',
    logLevel: 'off',
    transport() {
      return new CapturingTransport();
    },
  });

  setTimeout(() => {
    const metricsets = agent._apmClient.metricsets;
    t.ok(metricsets.length > 0, 'got metricsets');
    t.equal(
      metricsets[0].tags.hostname,
      '172.31.27.225',
      'EC2-internal hostname normalized to dotted IP',
    );
    agent.destroy();
    t.end();
  }, 1500);
});
