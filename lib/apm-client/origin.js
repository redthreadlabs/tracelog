/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const os = require('os');

const { normalizeHost } = require('./s3-uploader');

/**
 * The writer's origin: the object a file sink writes as each file's
 * `metadata` header and the callback sink hands with each batch. Cloud
 * metadata, extra metadata, the metadata filters and the channel are
 * applied later, by the sink.
 */
function buildOrigin(opts) {
  return {
    service: {
      name: opts.serviceName || 'unknown',
      version: opts.serviceVersion || undefined,
      environment: opts.environment || undefined,
      ...(opts.serviceNodeName && {
        node: { configured_name: opts.serviceNodeName },
      }),
      agent: { name: 'tracelog', version: require('../../package').version },
    },
    process: {
      pid: process.pid,
      title: process.title,
      argv: process.argv,
    },
    system: {
      // Normalized the same way as the host in S3 keys, so a viewer
      // can correlate metadata with key-derived hosts using one rule.
      hostname: normalizeHost(os.hostname()),
      architecture: os.arch(),
      platform: os.platform(),
    },
    ...(opts.globalLabels && { labels: opts.globalLabels }),
  };
}

function buildTruncOpts(opts) {
  return {
    truncateKeywordsAt:
      opts.truncateKeywordsAt != null ? opts.truncateKeywordsAt : 1024,
    truncateLongFieldsAt:
      opts.truncateLongFieldsAt != null ? opts.truncateLongFieldsAt : 10000,
    truncateErrorMessagesAt:
      opts.truncateErrorMessagesAt != null
        ? opts.truncateErrorMessagesAt
        : undefined,
  };
}

module.exports = { buildOrigin, buildTruncOpts };
