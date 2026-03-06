/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Copyright Shaxpir Inc. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const { INTAKE_STRING_MAX_SIZE } = require('../constants');
const { CloudMetadata } = require('../cloud-metadata');
const { JsonlFileClient } = require('./jsonl-file-client');
const { NoopApmClient } = require('./noop-apm-client');

/**
 * Returns a tracelog client suited for the configuration provided.
 *
 * @param {Object} config The agent's configuration
 * @param {Object} agent The agent instance
 */
function createApmClient(config, agent) {
  if (config.contextPropagationOnly) {
    return new NoopApmClient();
  } else if (typeof config.transport === 'function') {
    return config.transport(config, agent);
  }

  const client = new JsonlFileClient({
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
    globalLabels: maybePairsToObject(config.globalLabels),

    // Sanitize conf
    truncateKeywordsAt: INTAKE_STRING_MAX_SIZE,
    truncateLongFieldsAt: config.longFieldMaxLength,

    // JSONL file options
    filePath: config.logFilePath,
    maxFileSize: config.logMaxFileSize,
    maxFiles: config.logMaxFiles,
    flushIntervalMs: config.logFlushIntervalMs,

    // Cloud metadata
    cloudMetadataFetcher:
      config.cloudProvider !== 'none'
        ? new CloudMetadata(
            config.cloudProvider || 'auto',
            agent.logger,
            config.serviceName,
          )
        : null,

    // Logging
    logger: config.logger,
  });

  client.on('error', (err) => {
    agent.logger.error('Tracelog transport error: %s', err.stack);
  });

  return client;
}

function maybePairsToObject(pairs) {
  return pairs ? pairsToObject(pairs) : undefined;
}

function pairsToObject(pairs) {
  return pairs.reduce((object, [key, value]) => {
    object[key] = value;
    return object;
  }, {});
}

module.exports = {
  createApmClient,
};
