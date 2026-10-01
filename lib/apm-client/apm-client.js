/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const { INTAKE_STRING_MAX_SIZE } = require('../constants');
const { CloudMetadata } = require('../cloud-metadata');
const { CallbackClient } = require('./callback-client');
const { JsonlFileClient } = require('./jsonl-file-client');
const { NoopApmClient } = require('./noop-apm-client');
const { S3Uploader } = require('./s3-uploader');
const { TeeClient } = require('./tee-client');

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

  const sink = config.sink || 'file';
  const common = commonOpts(config, agent);
  let client;
  if (sink === 'callback') {
    client = createCallbackClient(config, agent, common);
  } else if (sink === 'both') {
    client = new TeeClient(
      createFileClient(config, common),
      createCallbackClient(config, agent, common),
    );
  } else {
    client = createFileClient(config, common);
  }

  client.on('error', (err) => {
    agent.logger.error('Tracelog transport error: %s', err.stack);
  });

  return client;
}

function commonOpts(config, agent) {
  return {
    serviceName: config.serviceName,
    serviceNodeName: config.serviceNodeName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
    globalLabels: maybePairsToObject(config.globalLabels),

    // Sanitize conf
    truncateKeywordsAt: INTAKE_STRING_MAX_SIZE,
    truncateLongFieldsAt: config.longFieldMaxLength,

    defaultChannel: config.defaultChannel,
    flushIntervalMs: config.logFlushIntervalMs,

    // Cloud metadata
    cloudMetadataFetcher:
      config.cloudProvider !== 'none'
        ? fetchOnce(
            new CloudMetadata(
              config.cloudProvider || 'auto',
              agent.logger,
              config.serviceName,
            ),
          )
        : null,

    // Logging
    logger: config.logger,
  };
}

// One cloud-metadata fetch, however many sinks ask for it.
function fetchOnce(fetcher) {
  let result = null;
  let waiting = null;
  return {
    getCloudMetadata(cb) {
      if (result) {
        process.nextTick(cb, result[0], result[1]);
        return;
      }
      if (waiting) {
        waiting.push(cb);
        return;
      }
      waiting = [cb];
      fetcher.getCloudMetadata((err, cloudMetadata) => {
        result = [err, cloudMetadata];
        const callbacks = waiting;
        waiting = null;
        for (const callback of callbacks) callback(err, cloudMetadata);
      });
    },
  };
}

function createCallbackClient(config, agent, common) {
  return new CallbackClient({
    ...common,
    batchSize: config.sinkBatchSize,
    maxQueueSize: config.sinkMaxQueueSize,
    handler: agent._batchHandler,
  });
}

function createFileClient(config, common) {
  // Create S3 uploader if a bucket is configured.
  let s3Uploader = null;
  if (config.s3Bucket) {
    s3Uploader = new S3Uploader({
      bucket: config.s3Bucket,
      region: config.s3Region,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
      sessionToken: config.s3SessionToken,
      s3Client: config.s3Client, // optional: inject a mock for testing
      gzipCompleted: config.s3GzipCompleted,
      gzipCurrent: config.s3GzipCurrent,
      logger: config.logger,
    });
  }

  return new JsonlFileClient({
    ...common,

    // JSONL file options
    logDir: config.logDir,
    logFilePrefix: config.logFilePrefix,
    maxFileSize: config.logMaxFileSize,
    rotationSchedule: config.logRotationSchedule,
    maxLocalRetentionDays: config.maxLocalRetentionDays,
    maxBufferSize: config.maxBufferSize,

    // S3 upload
    s3Uploader,
    s3UploadIntervalMs: config.s3UploadIntervalMs,
  });
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
