const cloneDeep = require('lodash.clonedeep');
const StreamDemux = require('stream-demux');
const AsyncStreamEmitter = require('async-stream-emitter');
const Response = require('./response').Response;

const scErrors = require('sc-errors');
const InvalidArgumentsError = scErrors.InvalidArgumentsError;
const SocketProtocolError = scErrors.SocketProtocolError;
const TimeoutError = scErrors.TimeoutError;
const InvalidActionError = scErrors.InvalidActionError;
const AuthError = scErrors.AuthError;


function SCServerSocket(id, server, socket) {
  AsyncStreamEmitter.call(this);

  this._autoAckRPCs = {
    '#publish': 1
  };

  this.id = id;
  this.server = server;
  this.socket = socket;
  this.state = this.CONNECTING;
  this.authState = this.UNAUTHENTICATED;
  this.active = true;

  this._receiverDemux = new StreamDemux();
  this._procedureDemux = new StreamDemux();

  this.request = this.socket.upgradeReq || {};

  // TODO 2: Do not check the wsEngine directly, instead, check if the this.request.connection object already exists or not.
  let wsEngine = this.server.options.wsEngine;
  if (wsEngine === 'sc-uws' || wsEngine === 'uws') {
    this.request.connection = this.socket._socket;
  }
  if (this.request.connection) {
    this.remoteAddress = this.request.connection.remoteAddress;
    this.remoteFamily = this.request.connection.remoteFamily;
    this.remotePort = this.request.connection.remotePort;
  } else {
    this.remoteAddress = this.request.remoteAddress;
    this.remoteFamily = this.request.remoteFamily;
    this.remotePort = this.request.remotePort;
  }
  if (this.request.forwardedForAddress) {
    this.forwardedForAddress = this.request.forwardedForAddress;
  }

  this._cid = 1;
  this._callbackMap = {};
  this._batchSendList = [];

  this.channelSubscriptions = {};
  this.channelSubscriptionsCount = 0;

  this.socket.on('error', (err) => {
    this.emitError(err);
  });

  this.socket.on('close', (code, data) => {
    this._onSCClose(code, data);
  });

  if (!this.server.pingTimeoutDisabled) {
    this._pingIntervalTicker = setInterval(this._sendPing.bind(this), this.server.pingInterval);
  }
  this._resetPongTimeout();

  // Receive incoming raw messages
  this.socket.on('message', (message, flags) => {
    this._resetPongTimeout();

    this.emit('message', {message});

    let obj;
    try {
      obj = this.decode(message);
    } catch (err) {
      if (err.name === 'Error') {
        err.name = 'InvalidMessageError';
      }
      this.emitError(err);
      return;
    }

    // If pong
    if (obj === '#2') {
      let token = this.getAuthToken();
      if (this.server.isAuthTokenExpired(token)) {
        this.deauthenticate();
      }
    } else {
      if (Array.isArray(obj)) {
        let len = obj.length;
        for (let i = 0; i < len; i++) {
          this._handleTransmittedEventObject(obj[i], message);
        }
      } else {
        this._handleTransmittedEventObject(obj, message);
      }
    }
  });
}

SCServerSocket.prototype = Object.create(AsyncStreamEmitter.prototype);

SCServerSocket.CONNECTING = SCServerSocket.prototype.CONNECTING = 'connecting';
SCServerSocket.OPEN = SCServerSocket.prototype.OPEN = 'open';
SCServerSocket.CLOSED = SCServerSocket.prototype.CLOSED = 'closed';

SCServerSocket.AUTHENTICATED = SCServerSocket.prototype.AUTHENTICATED = 'authenticated';
SCServerSocket.UNAUTHENTICATED = SCServerSocket.prototype.UNAUTHENTICATED = 'unauthenticated';

SCServerSocket.ignoreStatuses = scErrors.socketProtocolIgnoreStatuses;
SCServerSocket.errorStatuses = scErrors.socketProtocolErrorStatuses;

SCServerSocket.prototype.receiver = function (receiverName) {
  return this._receiverDemux.stream(receiverName);
};

SCServerSocket.prototype.closeReceiver = function (receiverName) {
  this._receiverDemux.close(receiverName);
};

SCServerSocket.prototype.procedure = function (procedureName) {
  return this._procedureDemux.stream(procedureName);
};

SCServerSocket.prototype.closeProcedure = function (procedureName) {
  this._procedureDemux.close(procedureName);
};

SCServerSocket.prototype._sendPing = function () {
  if (this.state !== this.CLOSED) {
    this.sendObject('#1');
  }
};

SCServerSocket.prototype._handleTransmittedEventObject = function (obj, message) {
  if (obj && obj.event != null) {
    let eventName = obj.event;

    let requestOptions = {
      socket: this,
      event: eventName,
      data: obj.data,
    };

    if (obj.cid == null) {
      this.server.verifyInboundTransmittedEvent(requestOptions, (err, newEventData) => {
        if (!err) {
          this._receiverDemux.write(eventName, newEventData);
        }
      });
    } else {
      requestOptions.cid = obj.cid;
      let response = new Response(this, requestOptions.cid);
      this.server.verifyInboundTransmittedEvent(requestOptions, (err, newEventData, ackData) => {
        if (err) {
          response.error(err); // TODO 2: No longer passing ackData as second param to response.error(err, ackData); check that it still works on client side.
        } else {
          if (this._autoAckRPCs[eventName]) {
            if (ackData !== undefined) {
              response.end(ackData);
            } else {
              response.end();
            }
          } else {
            this._procedureDemux.write(eventName, {
              data: newEventData,
              end: (data) => {
                response.end(data);
              },
              error: (err) => {
                response.error(err);
              }
            });
          }
        }
      });
    }
  } else if (obj && obj.rid != null) {
    // If incoming message is a response to a previously sent message
    let ret = this._callbackMap[obj.rid];
    if (ret) {
      clearTimeout(ret.timeout);
      delete this._callbackMap[obj.rid];
      let rehydratedError = scErrors.hydrateError(obj.error);
      ret.callback(rehydratedError, obj.data);
    }
  } else {
    // The last remaining case is to treat the message as raw
    this.emit('raw', {message});
  }
};

SCServerSocket.prototype._resetPongTimeout = function () {
  if (this.server.pingTimeoutDisabled) {
    return;
  }
  clearTimeout(this._pingTimeoutTicker);
  this._pingTimeoutTicker = setTimeout(() => {
    this._onSCClose(4001);
    this.socket.close(4001);
  }, this.server.pingTimeout);
};

SCServerSocket.prototype._nextCallId = function () {
  return this._cid++;
};

SCServerSocket.prototype.getState = function () {
  return this.state;
};

SCServerSocket.prototype.getBytesReceived = function () {
  return this.socket.bytesReceived;
};

SCServerSocket.prototype.emitError = function (error) {
  this.emit('error', {
    error
  });
};

SCServerSocket.prototype._onSCClose = function (code, reason) {
  clearInterval(this._pingIntervalTicker);
  clearTimeout(this._pingTimeoutTicker);

  if (this.state !== this.CLOSED) {
    let prevState = this.state;
    this.state = this.CLOSED;

    if (prevState === this.CONNECTING) {
      // Private connectAbort event for internal use only
      this.emit('connectAbort', {code, reason});
    } else {
      // Private disconnect event for internal use only
      this.emit('disconnect', {code, reason});
    }
    // Private close event for internal use only
    this.emit('close', {code, reason});

    if (!SCServerSocket.ignoreStatuses[code]) {
      let closeMessage;
      if (reason) {
        let reasonString;
        if (typeof reason === 'object') {
          try {
            reasonString = JSON.stringify(reason);
          } catch (error) {
            reasonString = reason.toString();
          }
        } else {
          reasonString = reason;
        }
        closeMessage = 'Socket connection closed with status code ' + code + ' and reason: ' + reasonString;
      } else {
        closeMessage = 'Socket connection closed with status code ' + code;
      }
      let err = new SocketProtocolError(SCServerSocket.errorStatuses[code] || closeMessage, code);
      this.emitError(err);
    }
  }
};

SCServerSocket.prototype.disconnect = function (code, data) {
  code = code || 1000;

  if (typeof code !== 'number') {
    let err = new InvalidArgumentsError('If specified, the code argument must be a number');
    this.emitError(err);
  }

  if (this.state !== this.CLOSED) {
    this._onSCClose(code, data);
    this.socket.close(code, data);
  }
};

SCServerSocket.prototype.destroy = function (code, data) {
  this.active = false;
  this.disconnect(code, data);
};

SCServerSocket.prototype.terminate = function () {
  this.socket.terminate();
};

SCServerSocket.prototype.send = function (data, options) {
  this.socket.send(data, options, (err) => {
    if (err) {
      this._onSCClose(1006, err.toString());
    }
  });
};

SCServerSocket.prototype.decode = function (message) {
  return this.server.codec.decode(message);
};

SCServerSocket.prototype.encode = function (object) {
  return this.server.codec.encode(object);
};

SCServerSocket.prototype.sendObjectBatch = function (object) {
  this._batchSendList.push(object);
  if (this._batchTimeout) {
    return;
  }

  this._batchTimeout = setTimeout(() => {
    delete this._batchTimeout;
    if (this._batchSendList.length) {
      let str;
      try {
        str = this.encode(this._batchSendList);
      } catch (err) {
        this.emitError(err);
      }
      if (str != null) {
        this.send(str);
      }
      this._batchSendList = [];
    }
  }, this.server.options.pubSubBatchDuration || 0);
};

SCServerSocket.prototype.sendObjectSingle = function (object) {
  let str;
  try {
    str = this.encode(object);
  } catch (err) {
    this.emitError(err);
  }
  if (str != null) {
    this.send(str);
  }
};

SCServerSocket.prototype.sendObject = function (object, options) {
  if (options && options.batch) {
    this.sendObjectBatch(object);
  } else {
    this.sendObjectSingle(object);
  }
};

SCServerSocket.prototype.transmit = function (event, data, options) {
  this.server.verifyOutboundEvent(this, event, data, options, (err, newData) => {
    let eventObject = {
      event: event
    };
    if (newData !== undefined) {
      eventObject.data = newData;
    }

    if (!err) {
      if (options && options.useCache && options.stringifiedData != null) {
        // Optimized
        this.send(options.stringifiedData);
      } else {
        this.sendObject(eventObject);
      }
    }
  });
  return Promise.resolve();
};

SCServerSocket.prototype.invoke = function (event, data, options) {
  return new Promise((resolve, reject) => {
    this.server.verifyOutboundEvent(this, event, data, options, (err, newData) => {
      if (err) {
        reject(err);
        return;
      }
      let eventObject = {
        event: event,
        cid: this._nextCallId()
      };
      if (newData !== undefined) {
        eventObject.data = newData;
      }

      let timeout = setTimeout(() => {
        let error = new TimeoutError("Event response for '" + event + "' timed out");
        delete this._callbackMap[eventObject.cid];
        reject(error);
      }, this.server.ackTimeout);

      this._callbackMap[eventObject.cid] = {
        callback: (err, result) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(result);
        },
        timeout: timeout
      };

      if (options && options.useCache && options.stringifiedData != null) {
        // Optimized
        this.send(options.stringifiedData);
      } else {
        this.sendObject(eventObject);
      }
    });
  });
};

SCServerSocket.prototype.triggerAuthenticationEvents = function (oldAuthState) {
  if (oldAuthState !== this.AUTHENTICATED) {
    let stateChangeData = {
      oldAuthState,
      newAuthState: this.authState,
      authToken: this.authToken
    };
    this.emit('authStateChange', stateChangeData);
    this.server.emit('authenticationStateChange', {
      socket: this,
      ...stateChangeData
    });
  }
  this.emit('authenticate', {authToken: this.authToken});
  this.server.emit('authentication', {
    socket: this,
    authToken: this.authToken
  });
};

SCServerSocket.prototype.setAuthToken = async function (data, options) {
  let authToken = cloneDeep(data);
  let oldAuthState = this.authState;
  this.authState = this.AUTHENTICATED;

  if (options == null) {
    options = {};
  } else {
    options = cloneDeep(options);
    if (options.algorithm != null) {
      delete options.algorithm;
      let err = new InvalidArgumentsError('Cannot change auth token algorithm at runtime - It must be specified as a config option on launch');
      this.emitError(err);
    }
  }

  options.mutatePayload = true;
  let rejectOnFailedDelivery = options.rejectOnFailedDelivery;
  delete options.rejectOnFailedDelivery;
  let defaultSignatureOptions = this.server.defaultSignatureOptions;

  // We cannot have the exp claim on the token and the expiresIn option
  // set at the same time or else auth.signToken will throw an error.
  let expiresIn;
  if (options.expiresIn == null) {
    expiresIn = defaultSignatureOptions.expiresIn;
  } else {
    expiresIn = options.expiresIn;
  }
  if (authToken) {
    if (authToken.exp == null) {
      options.expiresIn = expiresIn;
    } else {
      delete options.expiresIn;
    }
  } else {
    options.expiresIn = expiresIn;
  }

  // Always use the default sync/async signing mode since it cannot be changed at runtime.
  if (defaultSignatureOptions.async != null) {
    options.async = defaultSignatureOptions.async;
  }
  // Always use the default algorithm since it cannot be changed at runtime.
  if (defaultSignatureOptions.algorithm != null) {
    options.algorithm = defaultSignatureOptions.algorithm;
  }

  this.authToken = authToken;

  let handleAuthTokenSignFail = (error) => {
    this.emitError(error);
    this._onSCClose(4002, error.toString());
    this.socket.close(4002);
    throw error;
  };

  let sendAuthTokenToClient = async (signedToken) => {
    let tokenData = {
      token: signedToken
    };
    try {
      return await this.invoke('#setAuthToken', tokenData);
    } catch (err) {
      throw new AuthError('Failed to deliver auth token to client - ' + err.message);
    }
  };

  let signTokenResult;

  try {
    signTokenResult = this.server.auth.signToken(authToken, this.server.signatureKey, options);
  } catch (err) {
    handleAuthTokenSignFail(err);
  }

  let signedAuthToken;
  if (signTokenResult instanceof Promise) {
    try {
      signedAuthToken = await signTokenResult;
    } catch (err) {
      handleAuthTokenSignFail(err);
    }
  } else {
    signedAuthToken = signTokenResult;
  }
  if (this.authToken === authToken) {
    this.signedAuthToken = signedAuthToken;
    this.emit('authTokenSigned', {signedAuthToken});
  }

  this.triggerAuthenticationEvents(oldAuthState);
  try {
    await sendAuthTokenToClient(signedAuthToken);
  } catch (err) {
    this.emitError(err);
    if (rejectOnFailedDelivery) {
      throw err;
    }
  }
};

SCServerSocket.prototype.getAuthToken = function () {
  return this.authToken;
};

SCServerSocket.prototype.deauthenticateSelf = function () {
  let oldAuthState = this.authState;
  let oldAuthToken = this.authToken;
  this.signedAuthToken = null;
  this.authToken = null;
  this.authState = this.UNAUTHENTICATED;
  if (oldAuthState !== this.UNAUTHENTICATED) {
    let stateChangeData = {
      oldAuthState,
      newAuthState: this.authState
    };
    this.emit('authStateChange', stateChangeData);
    this.server.emit('authenticationStateChange', {
      socket: this,
      ...stateChangeData
    });
  }
  this.emit('deauthenticate', {oldAuthToken});
  this.server.emit('deauthentication', {
    socket: this,
    oldAuthToken
  });
};

SCServerSocket.prototype.deauthenticate = function () {
  this.deauthenticateSelf();
  return this.invoke('#removeAuthToken');
};

SCServerSocket.prototype.kickOut = function (channel, message) {
  if (channel == null) {
    Object.keys(this.channelSubscriptions).forEach((channelName) => {
      delete this.channelSubscriptions[channelName];
      this.channelSubscriptionsCount--;
      this.transmit('#kickOut', {message: message, channel: channelName});
    });
  } else {
    delete this.channelSubscriptions[channel];
    this.channelSubscriptionsCount--;
    this.transmit('#kickOut', {message: message, channel: channel});
  }
  return this.server.brokerEngine.unsubscribeSocket(this, channel);
};

SCServerSocket.prototype.subscriptions = function () {
  return Object.keys(this.channelSubscriptions);
};

SCServerSocket.prototype.isSubscribed = function (channel) {
  return !!this.channelSubscriptions[channel];
};

module.exports = SCServerSocket;
