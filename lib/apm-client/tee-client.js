/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const EventEmitter = require('events');

/**
 * The `both` sink: every call goes to the file client unchanged and to the
 * callback client. Events from either are re-emitted.
 */
class TeeClient extends EventEmitter {
  constructor(fileClient, callbackClient) {
    super();
    this._file = fileClient;
    this._callback = callbackClient;
    for (const client of [fileClient, callbackClient]) {
      client.on('error', (err) => this.emit('error', err));
    }
    callbackClient.on('drop', (count) => this.emit('drop', count));
  }

  get dropCount() {
    return this._callback.dropCount;
  }

  get queueSize() {
    return this._callback.queueSize;
  }

  setHandler(handler) {
    this._callback.setHandler(handler);
  }

  config(opts) {
    this._file.config(opts);
    this._callback.config(opts);
  }

  addMetadataFilter(fn) {
    this._file.addMetadataFilter(fn);
    this._callback.addMetadataFilter(fn);
  }

  setExtraMetadata(metadata) {
    this._file.setExtraMetadata(metadata);
    this._callback.setExtraMetadata(metadata);
  }

  supportsKeepingUnsampledTransaction() {
    return true;
  }

  lambdaStart() {}
  lambdaShouldRegisterTransactions() {
    return true;
  }
  lambdaRegisterTransaction(trans, awsRequestId) {}

  sendTransaction(transaction, cb) {
    this._file.sendTransaction(transaction);
    this._callback.sendTransaction(transaction, cb);
  }

  sendSpan(span, cb) {
    this._file.sendSpan(span);
    this._callback.sendSpan(span, cb);
  }

  sendError(error, cb) {
    this._file.sendError(error);
    this._callback.sendError(error, cb);
  }

  sendMetricSet(metricset, cb) {
    this._file.sendMetricSet(metricset);
    this._callback.sendMetricSet(metricset, cb);
  }

  sendEvent(event, cb) {
    this._file.sendEvent(event);
    this._callback.sendEvent(event, cb);
  }

  sendToChannel(channel, kind, data, cb) {
    this._file.sendToChannel(channel, kind, data);
    this._callback.sendToChannel(channel, kind, data, cb);
  }

  flush(opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    let pending = 2;
    const done = () => {
      if (--pending === 0 && cb) cb();
    };
    this._file.flush(opts, done);
    this._callback.flush(opts, done);
  }

  destroy() {
    this._file.destroy();
    this._callback.destroy();
  }
}

module.exports = { TeeClient };
