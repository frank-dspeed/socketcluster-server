var assert = require('assert');
var socketClusterServer = require('../');
var socketCluster = require('socketcluster-client');
var localStorage = require('localStorage');
var SCSimpleBroker = require('sc-simple-broker').SCSimpleBroker;

// TODO 2: Use const and let instead of var everywhere; in source code as well as tests.
// Add to the global scope like in browser.
global.localStorage = localStorage;

var portNumber = 8008;

var clientOptions;
var serverOptions;

var allowedUsers = {
  bob: true,
  alice: true
};

var TEN_DAYS_IN_SECONDS = 60 * 60 * 24 * 10;
var WS_ENGINE = 'ws';

var validSignedAuthTokenBob = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImJvYiIsImV4cCI6MzE2Mzc1ODk3OTA4MDMxMCwiaWF0IjoxNTAyNzQ3NzQ2fQ.dSZOfsImq4AvCu-Or3Fcmo7JNv1hrV3WqxaiSKkTtAo';
var validSignedAuthTokenAlice = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFsaWNlIiwiaWF0IjoxNTE4NzI4MjU5LCJleHAiOjMxNjM3NTg5NzkwODAzMTB9.XxbzPPnnXrJfZrS0FJwb_EAhIu2VY5i7rGyUThtNLh4';
var invalidSignedAuthToken = 'fakebGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fakec2VybmFtZSI6ImJvYiIsImlhdCI6MTUwMjYyNTIxMywiZXhwIjoxNTAyNzExNjEzfQ.fakemYcOOjM9bzmS4UYRvlWSk_lm3WGHvclmFjLbyOk';

var server, client;

function wait(duration) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
}

async function resolveAfterTimeout(duration, value) {
  await wait(duration);
  return value;
};

function connectionHandler(socket) {
  (async () => {
    for await (let rpc of socket.procedure('login')) {
      if (allowedUsers[rpc.data.username]) {
        socket.setAuthToken(rpc.data);
        rpc.end();
      } else {
        var err = new Error('Failed to login');
        err.name = 'FailedLoginError';
        rpc.error(err);
      }
    }
  })();

  (async () => {
    for await (let rpc of socket.procedure('loginWithTenDayExpiry')) {
      if (allowedUsers[rpc.data.username]) {
        socket.setAuthToken(rpc.data, {
          expiresIn: TEN_DAYS_IN_SECONDS
        });
        rpc.end();
      } else {
        var err = new Error('Failed to login');
        err.name = 'FailedLoginError';
        rpc.error(err);
      }
    }
  })();

  (async () => {
    for await (let rpc of socket.procedure('loginWithTenDayExp')) {
      if (allowedUsers[rpc.data.username]) {
        rpc.data.exp = Math.round(Date.now() / 1000) + TEN_DAYS_IN_SECONDS;
        socket.setAuthToken(rpc.data);
        rpc.end();
      } else {
        var err = new Error('Failed to login');
        err.name = 'FailedLoginError';
        rpc.error(err);
      }
    }
  })();

  (async () => {
    for await (let rpc of socket.procedure('loginWithTenDayExpAndExpiry')) {
      if (allowedUsers[rpc.data.username]) {
        rpc.data.exp = Math.round(Date.now() / 1000) + TEN_DAYS_IN_SECONDS;
        socket.setAuthToken(rpc.data, {
          expiresIn: TEN_DAYS_IN_SECONDS * 100 // 1000 days
        });
        rpc.end();
      } else {
        var err = new Error('Failed to login');
        err.name = 'FailedLoginError';
        rpc.error(err);
      }
    }
  })();

  (async () => {
    for await (let rpc of socket.procedure('loginWithIssAndIssuer')) {
      if (allowedUsers[rpc.data.username]) {
        rpc.data.iss = 'foo';
        try {
          await socket.setAuthToken(rpc.data, {
            issuer: 'bar'
          });
        } catch (err) {}
        rpc.end();
      } else {
        var err = new Error('Failed to login');
        err.name = 'FailedLoginError';
        rpc.error(err);
      }
    }
  })();

  (async () => {
    for await (let rpc of socket.procedure('setAuthKey')) {
      server.signatureKey = rpc.data;
      server.verificationKey = rpc.data;
      rpc.end();
    }
  })();
};

function destroyTestCase() {
  if (client) {
    if (client.state !== client.CLOSED) {
      client.disconnect();
      client.closeListener('close');
      client.closeListener('connectAbort');
      client.closeListener('disconnect');
    }
  }
};

describe('Integration tests', function () {
  beforeEach('Run the server before start', async function () {
    clientOptions = {
      hostname: '127.0.0.1',
      multiplex: false,
      port: portNumber
    };
    serverOptions = {
      authKey: 'testkey',
      wsEngine: WS_ENGINE
    };

    server = socketClusterServer.listen(portNumber, serverOptions);

    (async () => {
      for await (let {socket} of server.listener('connection')) {
        connectionHandler(socket);
      }
    })();

    server.addMiddleware(server.MIDDLEWARE_AUTHENTICATE, async function (req) {
      if (req.authToken.username === 'alice') {
        var err = new Error('Blocked by MIDDLEWARE_AUTHENTICATE');
        err.name = 'AuthenticateMiddlewareError';
        throw err;
      }
    });

    await server.listener('ready').once();
  });

  afterEach('Shut down client after each test', async function () {
    server.close();
    portNumber++;
    destroyTestCase();
    global.localStorage.removeItem('socketCluster.authToken');
  });

  describe('Socket authentication', function () {
    it('Should not send back error if JWT is not provided in handshake', async function () {
      client = socketCluster.create(clientOptions);
      let packet = await client.listener('connect').once();
      assert.equal(packet.authError === undefined, true);
    });

    it('Should be authenticated on connect if previous JWT token is present', async function () {
      client = socketCluster.create(clientOptions);
      await client.listener('connect').once();
      client.invoke('login', {username: 'bob'});
      await client.listener('authenticate').once();
      assert.equal(client.authState, 'authenticated');
      client.disconnect();
      client.connect();
      let packet = await client.listener('connect').once();
      assert.equal(packet.isAuthenticated, true);
      assert.equal(packet.authError === undefined, true);
    });

    it('Should send back error if JWT is invalid during handshake', async function () {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);

      client = socketCluster.create(clientOptions);

      await client.listener('connect').once();
      // Change the setAuthKey to invalidate the current token.
      await client.invoke('setAuthKey', 'differentAuthKey');
      client.disconnect();
      client.connect();
      let packet = await client.listener('connect').once();
      assert.equal(packet.isAuthenticated, false);
      assert.notEqual(packet.authError, null);
      assert.equal(packet.authError.name, 'AuthTokenInvalidError');
    });

    it('Should allow switching between users', async function () {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);

      var authenticateEvents = [];
      var deauthenticateEvents = [];
      var authenticationStateChangeEvents = [];
      var authStateChangeEvents = [];

      (async () => {
        for await (let stateChangePacket of server.listener('authenticationStateChange')) {
          authenticationStateChangeEvents.push(stateChangePacket);
        }
      })();

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          (async () => {
            for await (let {authToken} of socket.listener('authenticate')) {
              authenticateEvents.push(authToken);
            }
          })();
          (async () => {
            for await (let {oldAuthToken} of socket.listener('deauthenticate')) {
              deauthenticateEvents.push(oldAuthToken);
            }
          })();
          (async () => {
            for await (let stateChangeData of socket.listener('authStateChange')) {
              authStateChangeEvents.push(stateChangeData);
            }
          })();
        }
      })();

      var clientSocketId;
      client = socketCluster.create(clientOptions);
      await client.listener('connect').once();
      clientSocketId = client.id;
      client.invoke('login', {username: 'alice'});

      await wait(100);

      assert.equal(deauthenticateEvents.length, 0);
      assert.equal(authenticateEvents.length, 2);
      assert.equal(authenticateEvents[0].username, 'bob');
      assert.equal(authenticateEvents[1].username, 'alice');

      assert.equal(authenticationStateChangeEvents.length, 1);
      assert.notEqual(authenticationStateChangeEvents[0].socket, null);
      assert.equal(authenticationStateChangeEvents[0].socket.id, clientSocketId);
      assert.equal(authenticationStateChangeEvents[0].oldAuthState, 'unauthenticated');
      assert.equal(authenticationStateChangeEvents[0].newAuthState, 'authenticated');
      assert.notEqual(authenticationStateChangeEvents[0].authToken, null);
      assert.equal(authenticationStateChangeEvents[0].authToken.username, 'bob');

      assert.equal(authStateChangeEvents.length, 1);
      assert.equal(authStateChangeEvents[0].oldAuthState, 'unauthenticated');
      assert.equal(authStateChangeEvents[0].newAuthState, 'authenticated');
      assert.notEqual(authStateChangeEvents[0].authToken, null);
      assert.equal(authStateChangeEvents[0].authToken.username, 'bob');
    });

    it('Should emit correct events/data when socket is deauthenticated', async function () {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);

      var authenticationStateChangeEvents = [];
      var authStateChangeEvents = [];

      (async () => {
        for await (let stateChangePacket of server.listener('authenticationStateChange')) {
          authenticationStateChangeEvents.push(stateChangePacket);
        }
      })();

      client = socketCluster.create(clientOptions);

      (async () => {
        for await (let packet of client.listener('connect')) {
          client.deauthenticate();
        }
      })();

      let {socket} = await server.listener('connection').once();
      let initialAuthToken = socket.authToken;

      (async () => {
        for await (let stateChangeData of socket.listener('authStateChange')) {
          authStateChangeEvents.push(stateChangeData);
        }
      })();

      let {oldAuthToken} = await socket.listener('deauthenticate').once();
      assert.equal(oldAuthToken, initialAuthToken);

      assert.equal(authStateChangeEvents.length, 2);
      assert.equal(authStateChangeEvents[0].oldAuthState, 'unauthenticated');
      assert.equal(authStateChangeEvents[0].newAuthState, 'authenticated');
      assert.notEqual(authStateChangeEvents[0].authToken, null);
      assert.equal(authStateChangeEvents[0].authToken.username, 'bob');
      assert.equal(authStateChangeEvents[1].oldAuthState, 'authenticated');
      assert.equal(authStateChangeEvents[1].newAuthState, 'unauthenticated');
      assert.equal(authStateChangeEvents[1].authToken, null);

      assert.equal(authenticationStateChangeEvents.length, 2);
      assert.notEqual(authenticationStateChangeEvents[0], null);
      assert.equal(authenticationStateChangeEvents[0].oldAuthState, 'unauthenticated');
      assert.equal(authenticationStateChangeEvents[0].newAuthState, 'authenticated');
      assert.notEqual(authenticationStateChangeEvents[0].authToken, null);
      assert.equal(authenticationStateChangeEvents[0].authToken.username, 'bob');
      assert.notEqual(authenticationStateChangeEvents[1], null);
      assert.equal(authenticationStateChangeEvents[1].oldAuthState, 'authenticated');
      assert.equal(authenticationStateChangeEvents[1].newAuthState, 'unauthenticated');
      assert.equal(authenticationStateChangeEvents[1].authToken, null);
    });

    it('Should not authenticate the client if MIDDLEWARE_AUTHENTICATE blocks the authentication', async function () {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenAlice);

      client = socketCluster.create(clientOptions);
      // The previous test authenticated us as 'alice', so that token will be passed to the server as
      // part of the handshake.

      let packet = await client.listener('connect').once();
      // Any token containing the username 'alice' should be blocked by the MIDDLEWARE_AUTHENTICATE middleware.
      // This will only affects token-based authentication, not the credentials-based login event.
      assert.equal(packet.isAuthenticated, false);
      assert.notEqual(packet.authError, null);
      assert.equal(packet.authError.name, 'AuthenticateMiddlewareError');
    });

    it('Token should be available after Promise resolves if token engine signing is synchronous', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authSignAsync: false
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();

      client.invoke('login', {username: 'bob'});
      await client.listener('authenticate').once();

      assert.equal(client.authState, 'authenticated');
      assert.notEqual(client.authToken, null);
      assert.equal(client.authToken.username, 'bob');
    });

    it('If token engine signing is asynchronous, authentication can be captured using the authenticate event', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authSignAsync: true
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();

      client.invoke('login', {username: 'bob'});
      await client.listener('authenticate').once();

      assert.equal(client.authState, 'authenticated');
      assert.notEqual(client.authToken, null);
      assert.equal(client.authToken.username, 'bob');
    });

    it('Should still work if token verification is asynchronous', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authVerifyAsync: false
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();

      client.invoke('login', {username: 'bob'});

      await client.listener('authenticate').once();

      client.disconnect();
      client.connect();

      let packet = await client.listener('connect').once();

      assert.equal(packet.isAuthenticated, true);
      assert.notEqual(client.authToken, null);
      assert.equal(client.authToken.username, 'bob');
    });

    it('Should set the correct expiry when using expiresIn option when creating a JWT with socket.setAuthToken', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authVerifyAsync: false
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();
      client.invoke('loginWithTenDayExpiry', {username: 'bob'});
      await client.listener('authenticate').once();

      assert.notEqual(client.authToken, null);
      assert.notEqual(client.authToken.exp, null);
      var dateMillisecondsInTenDays = Date.now() + TEN_DAYS_IN_SECONDS * 1000;
      var dateDifference = Math.abs(dateMillisecondsInTenDays - client.authToken.exp * 1000);
      // Expiry must be accurate within 1000 milliseconds.
      assert.equal(dateDifference < 1000, true);
    });

    it('Should set the correct expiry when adding exp claim when creating a JWT with socket.setAuthToken', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authVerifyAsync: false
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();
      client.invoke('loginWithTenDayExp', {username: 'bob'});
      await client.listener('authenticate').once();

      assert.notEqual(client.authToken, null);
      assert.notEqual(client.authToken.exp, null);
      var dateMillisecondsInTenDays = Date.now() + TEN_DAYS_IN_SECONDS * 1000;
      var dateDifference = Math.abs(dateMillisecondsInTenDays - client.authToken.exp * 1000);
      // Expiry must be accurate within 1000 milliseconds.
      assert.equal(dateDifference < 1000, true);
    });

    it('The exp claim should have priority over expiresIn option when using socket.setAuthToken', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authVerifyAsync: false
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();
      client.invoke('loginWithTenDayExpAndExpiry', {username: 'bob'});
      await client.listener('authenticate').once();

      assert.notEqual(client.authToken, null);
      assert.notEqual(client.authToken.exp, null);
      var dateMillisecondsInTenDays = Date.now() + TEN_DAYS_IN_SECONDS * 1000;
      var dateDifference = Math.abs(dateMillisecondsInTenDays - client.authToken.exp * 1000);
      // Expiry must be accurate within 1000 milliseconds.
      assert.equal(dateDifference < 1000, true);
    });

    it('Should send back error if socket.setAuthToken tries to set both iss claim and issuer option', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authVerifyAsync: false
      });
      var warningMap = {};

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();

      (async () => {
        await client.listener('authenticate').once();
        throw new Error('Should not pass authentication because the signature should fail');
      })();

      (async () => {
        for await (let {warning} of server.listener('warning')) {
          assert.notEqual(warning, null);
          warningMap[warning.name] = warning;
        }
      })();

      (async () => {
        for await (let {error} of server.listener('error')) {
          assert.notEqual(error, null);
          assert.equal(error.name, 'SocketProtocolError');
        }
      })();

      let closePackets = [];

      (async () => {
        let packet = await client.listener('close').once();
        closePackets.push(packet);
      })();

      let error;
      try {
        await client.invoke('loginWithIssAndIssuer', {username: 'bob'});
      } catch (err) {
        error = err;
      }

      assert.notEqual(error, null);
      assert.equal(error.name, 'BadConnectionError');

      await wait(1000);

      assert.equal(closePackets.length, 1);
      assert.equal(closePackets[0].code, 4002);
      server.closeListener('warning');
      assert.notEqual(warningMap['SocketProtocolError'], null);
    });

    it('Should trigger an authTokenSigned event and socket.signedAuthToken should be set after calling the socket.setAuthToken method', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authSignAsync: true
      });

      var authTokenSignedEventEmitted = false;

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          (async () => {
            for await (let {signedAuthToken} of socket.listener('authTokenSigned')) {
              authTokenSignedEventEmitted = true;
              assert.notEqual(signedAuthToken, null);
              assert.equal(signedAuthToken, socket.signedAuthToken);
            }
          })();

          (async () => {
            for await (let req of socket.procedure('login')) {
              if (allowedUsers[req.data.username]) {
                socket.setAuthToken(req.data, {async: true});
                req.end();
              } else {
                var err = new Error('Failed to login');
                err.name = 'FailedLoginError';
                req.error(err);
              }
            }
          })();
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('connect').once();
      await client.invoke('login', {username: 'bob'});
      await client.listener('authenticate').once();

      assert.equal(authTokenSignedEventEmitted, true);
    });

    it('Should reject Promise returned by socket.setAuthToken if token delivery fails and rejectOnFailedDelivery option is true', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authSignAsync: true,
        ackTimeout: 1000
      });

      var socketErrors = [];

      (async () => {
        await server.listener('ready').once();
        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });
        await client.listener('connect').once();
        client.invoke('login', {username: 'bob'});
      })();

      let {socket} = await server.listener('connection').once();

      (async () => {
        for await (let {error} of socket.listener('error')) {
          socketErrors.push(error);
        }
      })();

      let req = await socket.procedure('login').once();
      if (allowedUsers[req.data.username]) {
        req.end();
        socket.disconnect();
        let error;
        try {
          await socket.setAuthToken(req.data, {rejectOnFailedDelivery: true});
        } catch (err) {
          error = err;
        }
        assert.notEqual(error, null);
        assert.equal(error.name, 'AuthError');
        await wait(0);
        assert.notEqual(socketErrors[0], null);
        assert.equal(socketErrors[0].name, 'AuthError');
      } else {
        var err = new Error('Failed to login');
        err.name = 'FailedLoginError';
        req.error(err);
      }
    });

    it('Should not reject Promise returned by socket.setAuthToken if token delivery fails and rejectOnFailedDelivery option is not true', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        authSignAsync: true,
        ackTimeout: 1000
      });

      var socketErrors = [];

      (async () => {
        await server.listener('ready').once();
        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });
        await client.listener('connect').once();
        client.invoke('login', {username: 'bob'});
      })();

      let {socket} = await server.listener('connection').once();

      (async () => {
        for await (let {error} of socket.listener('error')) {
          socketErrors.push(error);
        }
      })();

      let req = await socket.procedure('login').once();
      if (allowedUsers[req.data.username]) {
        req.end();
        socket.disconnect();
        let error;
        try {
          await socket.setAuthToken(req.data);
        } catch (err) {
          error = err;
        }
        assert.equal(error, null);
        await wait(0);
        assert.notEqual(socketErrors[0], null);
        assert.equal(socketErrors[0].name, 'AuthError');
      } else {
        var err = new Error('Failed to login');
        err.name = 'FailedLoginError';
        req.error(err);
      }
    });

    it('The verifyToken method of the authEngine receives correct params', async function () {
      global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);

      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      (async () => {
        await server.listener('ready').once();
        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });
      })();

      return new Promise((resolve) => {
        server.setAuthEngine({
          verifyToken: async (signedAuthToken, verificationKey, verificationOptions) => {
            await wait(500);
            assert.equal(signedAuthToken, validSignedAuthTokenBob);
            assert.equal(verificationKey, serverOptions.authKey);
            assert.notEqual(verificationOptions, null);
            assert.notEqual(verificationOptions.socket, null);
            resolve();
            return Promise.resolve({});
          }
        });
      });
    });

    it('Should remove client data from the server when client disconnects before authentication process finished', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });
      server.setAuthEngine({
        verifyToken: function (signedAuthToken, verificationKey, verificationOptions) {
          return resolveAfterTimeout(500, {});
        }
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();
      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var serverSocket;
      (async () => {
        for await (let {socket} of server.listener('handshake')) {
          serverSocket = socket;
        }
      })();

      await wait(100);
      assert.equal(server.clientsCount, 0);
      assert.equal(server.pendingClientsCount, 1);
      assert.notEqual(serverSocket, null);
      assert.equal(Object.keys(server.pendingClients)[0], serverSocket.id);
      client.disconnect();

      await wait(1000);
      assert.equal(Object.keys(server.clients).length, 0);
      assert.equal(server.clientsCount, 0);
      assert.equal(server.pendingClientsCount, 0);
      assert.equal(JSON.stringify(server.pendingClients), '{}');
    });
  });

  describe('Socket handshake', function () {
    it('Exchange is attached to socket before the handshake event is triggered', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      let {socket} = await server.listener('handshake').once();
      assert.notEqual(socket.exchange, null);
    });
  });

  describe('Socket connection', function () {
    it('Server-side socket connect event and server connection event should trigger', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      var connectionEmitted = false;
      var connectionEvent;

      (async () => {
        for await (let event of server.listener('connection')) {
          connectionEvent = event;
          connectionHandler(event.socket);
          connectionEmitted = true;
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var connectEmitted = false;
      var connectStatus;
      var socketId;

      (async () => {
        for await (let {socket} of server.listener('handshake')) {
          (async () => {
            for await (let serverSocketStatus of socket.listener('connect')) {
              socketId = socket.id;
              connectEmitted = true;
              connectStatus = serverSocketStatus;
              // This is to check that mutating the status on the server
              // doesn't affect the status sent to the client.
              serverSocketStatus.foo = 123;
            }
          })();
        }
      })();

      var clientConnectEmitted = false;
      var clientConnectStatus = false;

      (async () => {
        for await (let packet of client.listener('connect')) {
          clientConnectEmitted = true;
          clientConnectStatus = packet;
        }
      })();

      await wait(300);

      assert.equal(connectEmitted, true);
      assert.equal(connectionEmitted, true);
      assert.equal(clientConnectEmitted, true);

      assert.notEqual(connectionEvent, null);
      assert.equal(connectionEvent.id, socketId);
      assert.equal(connectionEvent.pingTimeout, server.pingTimeout);
      assert.equal(connectionEvent.authError, null);
      assert.equal(connectionEvent.isAuthenticated, false);

      assert.notEqual(connectStatus, null);
      assert.equal(connectStatus.id, socketId);
      assert.equal(connectStatus.pingTimeout, server.pingTimeout);
      assert.equal(connectStatus.authError, null);
      assert.equal(connectStatus.isAuthenticated, false);

      assert.notEqual(clientConnectStatus, null);
      assert.equal(clientConnectStatus.id, socketId);
      assert.equal(clientConnectStatus.pingTimeout, server.pingTimeout);
      assert.equal(clientConnectStatus.authError, null);
      assert.equal(clientConnectStatus.isAuthenticated, false);
      assert.equal(clientConnectStatus.foo, null);
      // Client socket status should be a clone of server socket status; not
      // a reference to the same object.
      assert.notEqual(clientConnectStatus.foo, connectStatus.foo);
    });
  });

  describe('Socket disconnection', function () {
    it('Server-side socket disconnect event should not trigger if the socket did not complete the handshake; instead, it should trigger connectAbort', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });
      server.setAuthEngine({
        verifyToken: function (signedAuthToken, verificationKey, verificationOptions) {
          return resolveAfterTimeout(500, {});
        }
      });

      var connectionOnServer = false;

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionOnServer = true;
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var socketDisconnected = false;
      var socketDisconnectedBeforeConnect = false;
      var clientSocketAborted = false;

      (async () => {
        let {socket} = await server.listener('handshake').once();
        assert.equal(server.pendingClientsCount, 1);
        assert.notEqual(server.pendingClients[socket.id], null);

        (async () => {
          await socket.listener('disconnect').once();
          if (!connectionOnServer) {
            socketDisconnectedBeforeConnect = true;
          }
          socketDisconnected = true;
        })();

        (async () => {
          let packet = await socket.listener('connectAbort').once();
          clientSocketAborted = true;
          assert.equal(packet.code, 4444);
          assert.equal(packet.reason, 'Disconnect before handshake');
        })();
      })();

      var serverDisconnected = false;
      var serverSocketAborted = false;

      (async () => {
        await server.listener('disconnection').once();
        serverDisconnected = true;
      })();

      (async () => {
        await server.listener('connectionAbort').once();
        serverSocketAborted = true;
      })();

      await wait(100);
      client.disconnect(4444, 'Disconnect before handshake');

      await wait(1000);
      assert.equal(socketDisconnected, false);
      assert.equal(socketDisconnectedBeforeConnect, false);
      assert.equal(clientSocketAborted, true);
      assert.equal(serverSocketAborted, true);
      assert.equal(serverDisconnected, false);
    });

    it('Server-side socket disconnect event should trigger if the socket completed the handshake (not connectAbort)', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });
      server.setAuthEngine({
        verifyToken: function (signedAuthToken, verificationKey, verificationOptions) {
          return resolveAfterTimeout(10, {});
        }
      });

      var connectionOnServer = false;

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionOnServer = true;
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var socketDisconnected = false;
      var socketDisconnectedBeforeConnect = false;
      var clientSocketAborted = false;

      (async () => {
        let {socket} = await server.listener('handshake').once();
        assert.equal(server.pendingClientsCount, 1);
        assert.notEqual(server.pendingClients[socket.id], null);

        (async () => {
          let packet = await socket.listener('disconnect').once();
          if (!connectionOnServer) {
            socketDisconnectedBeforeConnect = true;
          }
          socketDisconnected = true;
          assert.equal(packet.code, 4445);
          assert.equal(packet.reason, 'Disconnect after handshake');
        })();

        (async () => {
          let packet = await socket.listener('connectAbort').once();
          clientSocketAborted = true;
        })();
      })();

      var serverDisconnected = false;
      var serverSocketAborted = false;

      (async () => {
        await server.listener('disconnection').once();
        serverDisconnected = true;
      })();

      (async () => {
        await server.listener('connectionAbort').once();
        serverSocketAborted = true;
      })();

      await wait(200);
      client.disconnect(4445, 'Disconnect after handshake');

      await wait(1000);

      assert.equal(socketDisconnectedBeforeConnect, false);
      assert.equal(socketDisconnected, true);
      assert.equal(clientSocketAborted, false);
      assert.equal(serverDisconnected, true);
      assert.equal(serverSocketAborted, false);
    });

    it('The close event should trigger when the socket loses the connection before the handshake', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });
      server.setAuthEngine({
        verifyToken: function (signedAuthToken, verificationKey, verificationOptions) {
          return resolveAfterTimeout(500, {});
        }
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionOnServer = true;
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var serverSocketClosed = false;
      var serverSocketAborted = false;
      var serverClosure = false;

      (async () => {
        for await (let {socket} of server.listener('handshake')) {
          let packet = await socket.listener('close').once();
          serverSocketClosed = true;
          assert.equal(packet.code, 4444);
          assert.equal(packet.reason, 'Disconnect before handshake');
        }
      })();

      (async () => {
        for await (let packet of server.listener('connectionAbort')) {
          serverSocketAborted = true;
        }
      })();

      (async () => {
        for await (let packet of server.listener('closure')) {
          assert.equal(packet.socket.state, packet.socket.CLOSED);
          serverClosure = true;
        }
      })();

      await wait(100);
      client.disconnect(4444, 'Disconnect before handshake');

      await wait(1000);
      assert.equal(serverSocketClosed, true);
      assert.equal(serverSocketAborted, true);
      assert.equal(serverClosure, true);
    });

    it('The close event should trigger when the socket loses the connection after the handshake', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });
      server.setAuthEngine({
        verifyToken: function (signedAuthToken, verificationKey, verificationOptions) {
          return resolveAfterTimeout(0, {});
        }
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionOnServer = true;
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var serverSocketClosed = false;
      var serverSocketDisconnected = false;
      var serverClosure = false;

      (async () => {
        for await (let {socket} of server.listener('handshake')) {
          let packet = await socket.listener('close').once();
          serverSocketClosed = true;
          assert.equal(packet.code, 4445);
          assert.equal(packet.reason, 'Disconnect after handshake');
        }
      })();

      (async () => {
        for await (let packet of server.listener('disconnection')) {
          serverSocketDisconnected = true;
        }
      })();

      (async () => {
        for await (let packet of server.listener('closure')) {
          assert.equal(packet.socket.state, packet.socket.CLOSED);
          serverClosure = true;
        }
      })();

      await wait(100);
      client.disconnect(4445, 'Disconnect after handshake');

      await wait(1000);
      assert.equal(serverSocketClosed, true);
      assert.equal(serverSocketDisconnected, true);
      assert.equal(serverClosure, true);
    });
  });

  describe('Socket pub/sub', function () {
    it('Should support subscription batching', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
          var isFirstMessage = true;

          (async () => {
            for await (let {message} of socket.listener('message')) {
              if (isFirstMessage) {
                var data = JSON.parse(message);
                // All 20 subscriptions should arrive as a single message.
                assert.equal(data.length, 20);
                isFirstMessage = false;
              }
            }
          })();
        }
      })();

      var subscribeMiddlewareCounter = 0;

      // Each subscription should pass through the middleware individually, even
      // though they were sent as a batch/array.
      server.addMiddleware(server.MIDDLEWARE_SUBSCRIBE, function (req, next) {
        subscribeMiddlewareCounter++;
        assert.equal(req.channel.indexOf('my-channel-'), 0);
        if (req.channel === 'my-channel-10') {
          assert.equal(JSON.stringify(req.data), JSON.stringify({foo: 123}));
        } else if (req.channel === 'my-channel-12') {
          // Block my-channel-12
          var err = new Error('You cannot subscribe to channel 12');
          err.name = 'UnauthorizedSubscribeError';
          next(err);
          return;
        }
        next();
      });

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var channelList = [];
      for (var i = 0; i < 20; i++) {
        var subscribeOptions = {
          batch: true
        };
        if (i === 10) {
          subscribeOptions.data = {foo: 123};
        }
        channelList.push(
          client.subscribe('my-channel-' + i, subscribeOptions)
        );
      }

      (async () => {
        for await (let packet of channelList[12].listener('subscribe')) {
          throw new Error('The my-channel-12 channel should have been blocked by MIDDLEWARE_SUBSCRIBE');
        }
      })();

      (async () => {
        for await (let packet of channelList[12].listener('subscribeFail')) {
          assert.notEqual(packet.error, null);
          assert.equal(packet.error.name, 'UnauthorizedSubscribeError');
        }
      })();

      (async () => {
        for await (let packet of channelList[0].listener('subscribe')) {
          client.publish('my-channel-19', 'Hello!');
        }
      })();

      for await (let data of channelList[19]) {
        assert.equal(data, 'Hello!');
        assert.equal(subscribeMiddlewareCounter, 20);
        break;
      }
    });

    it('Client should not be able to subscribe to a channel before the handshake has completed', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      server.setAuthEngine({
        verifyToken: function (signedAuthToken, verificationKey, verificationOptions) {
          return resolveAfterTimeout(500, {});
        }
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var isSubscribed = false;
      var error;

      (async () => {
        for await (let packet of server.listener('subscription')) {
          isSubscribed = true;
        }
      })();

      // Hack to capture the error without relying on the standard client flow.
      client.transport._callbackMap[2] = {
        event: '#subscribe',
        data: {"channel":"someChannel"},
        callback: function (err) {
          error = err;
        }
      };

      // Trick the server by sending a fake subscribe before the handshake is done.
      client.transport.socket.on('open', function () {
        client.send('{"event":"#subscribe","data":{"channel":"someChannel"},"cid":2}');
      });

      await wait(1000);
      assert.equal(isSubscribed, false);
      assert.notEqual(error, null);
      assert.equal(error.name, 'InvalidActionError');
    });

    it('Server should be able to handle invalid #subscribe and #unsubscribe and #publish packets without crashing', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          connectionHandler(socket);
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      var nullInChannelArrayError;
      var objectAsChannelNameError;
      var nullChannelNameError;
      var nullUnsubscribeError;

      var undefinedPublishError;
      var objectAsChannelNamePublishError;
      var nullPublishError;

      // Hacks to capture the errors without relying on the standard client flow.
      client.transport._callbackMap[2] = {
        event: '#subscribe',
        data: [null],
        callback: function (err) {
          nullInChannelArrayError = err;
        }
      };
      client.transport._callbackMap[3] = {
        event: '#subscribe',
        data: {"channel": {"hello": 123}},
        callback: function (err) {
          objectAsChannelNameError = err;
        }
      };
      client.transport._callbackMap[4] = {
        event: '#subscribe',
        data: null,
        callback: function (err) {
          nullChannelNameError = err;
        }
      };
      client.transport._callbackMap[5] = {
        event: '#unsubscribe',
        data: [null],
        callback: function (err) {
          nullUnsubscribeError = err;
        }
      };
      client.transport._callbackMap[6] = {
        event: '#publish',
        data: null,
        callback: function (err) {
          undefinedPublishError = err;
        }
      };
      client.transport._callbackMap[7] = {
        event: '#publish',
        data: {"channel": {"hello": 123}},
        callback: function (err) {
          objectAsChannelNamePublishError = err;
        }
      };
      client.transport._callbackMap[8] = {
        event: '#publish',
        data: {"channel": null},
        callback: function (err) {
          nullPublishError = err;
        }
      };

      (async () => {
        for await (let packet of client.listener('connect')) {
          // Trick the server by sending a fake subscribe before the handshake is done.
          client.send('{"event":"#subscribe","data":[null],"cid":2}');
          client.send('{"event":"#subscribe","data":{"channel":{"hello":123}},"cid":3}');
          client.send('{"event":"#subscribe","data":null,"cid":4}');
          client.send('{"event":"#unsubscribe","data":[null],"cid":5}');
          client.send('{"event":"#publish","data":null,"cid":6}');
          client.send('{"event":"#publish","data":{"channel":{"hello":123}},"cid":7}');
          client.send('{"event":"#publish","data":{"channel":null},"cid":8}');
        }
      })();

      await wait(300);

      assert.notEqual(nullInChannelArrayError, null);
      assert.notEqual(objectAsChannelNameError, null);
      assert.notEqual(nullChannelNameError, null);
      assert.notEqual(nullUnsubscribeError, null);
      assert.notEqual(undefinedPublishError, null);
      assert.notEqual(objectAsChannelNamePublishError, null);
      assert.notEqual(nullPublishError, null);
    });

    it('When default SCSimpleBroker broker engine is used, disconnect event should trigger before unsubscribe event', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      var eventList = [];

      (async () => {
        await server.listener('ready').once();

        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        await client.subscribe('foo').listener('subscribe').once();
        await wait(200);
        client.disconnect();
      })();

      let {socket} = await server.listener('connection').once();

      (async () => {
        for await (let packet of socket.listener('unsubscribe')) {
          eventList.push({
            type: 'unsubscribe',
            channel: packet.channel
          });
        }
      })();

      let disconnectPacket = await socket.listener('disconnect').once();
      eventList.push({
        type: 'disconnect',
        code: disconnectPacket.code,
        reason: disconnectPacket.data
      });

      await wait(0);
      assert.equal(eventList[0].type, 'disconnect');
      assert.equal(eventList[1].type, 'unsubscribe');
      assert.equal(eventList[1].channel, 'foo');
    });

    it('When disconnecting a socket, the unsubscribe event should trigger after the disconnect event', async function () {
      portNumber++;
      var customBrokerEngine = new SCSimpleBroker();
      var defaultUnsubscribeSocket = customBrokerEngine.unsubscribeSocket;
      customBrokerEngine.unsubscribeSocket = function (socket, channel) {
        return resolveAfterTimeout(100, defaultUnsubscribeSocket.call(this, socket, channel));
      };

      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        brokerEngine: customBrokerEngine
      });

      var eventList = [];

      (async () => {
        await server.listener('ready').once();
        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        for await (let packet of client.subscribe('foo').listener('subscribe')) {
          (async () => {
            await wait(200);
            client.disconnect();
          })();
        }
      })();

      let {socket} = await server.listener('connection').once();

      (async () => {
        for await (let packet of socket.listener('unsubscribe')) {
          eventList.push({
            type: 'unsubscribe',
            channel: packet.channel
          });
        }
      })();

      let packet = await socket.listener('disconnect').once();

      eventList.push({
        type: 'disconnect',
        code: packet.code,
        reason: packet.reason
      });

      await wait(0);
      assert.equal(eventList[0].type, 'disconnect');
      assert.equal(eventList[1].type, 'unsubscribe');
      assert.equal(eventList[1].channel, 'foo');
    });

    it('Socket should emit an error when trying to unsubscribe to a channel which it is not subscribed to', async function () {
      portNumber++;

      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      var errorList = [];

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          (async () => {
            for await (let {error} of socket.listener('error')) {
              errorList.push(error);
            }
          })();
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      let error;
      try {
        await client.invoke('#unsubscribe', 'bar');
      } catch (err) {
        error = err;
      }
      assert.notEqual(error, null);
      assert.equal(error.name, 'BrokerError');

      await wait(100);
      assert.equal(errorList.length, 1);
      assert.equal(errorList[0].name, 'BrokerError');
    });

    it('Socket should not receive messages from a channel which it has only just unsubscribed from (accounting for delayed unsubscribe by brokerEngine)', async function () {
      portNumber++;
      var customBrokerEngine = new SCSimpleBroker();
      var defaultUnsubscribeSocket = customBrokerEngine.unsubscribeSocket;
      customBrokerEngine.unsubscribeSocket = function (socket, channel) {
        return resolveAfterTimeout(300, defaultUnsubscribeSocket.call(this, socket, channel));
      };

      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE,
        brokerEngine: customBrokerEngine
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          (async () => {
            for await (let packet of socket.listener('unsubscribe')) {
              if (packet.channel === 'foo') {
                server.exchange.publish('foo', 'hello');
              }
            }
          })();
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });
      // Stub the isSubscribed method so that it always returns true.
      // That way the client will always invoke watchers whenever
      // it receives a #publish event.
      client.isSubscribed = function () { return true; };

      var messageList = [];

      var fooChannel = client.subscribe('foo');

      (async () => {
        for await (let data of fooChannel) {
          messageList.push(data);
        }
      })();

      (async () => {
        for await (let packet of fooChannel.listener('subscribe')) {
          client.invoke('#unsubscribe', 'foo');
        }
      })();

      await wait(200);
      assert.equal(messageList.length, 0);
    });

    it('Socket channelSubscriptions and channelSubscriptionsCount should update when socket.kickOut(channel) is called', async function () {
      portNumber++;

      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      var errorList = [];
      var serverSocket;
      var wasKickOutCalled = false;

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          serverSocket = socket;

          (async () => {
            for await (let {error} of socket.listener('error')) {
              errorList.push(error);
            }
          })();

          (async () => {
            for await (let packet of socket.listener('subscribe')) {
              if (packet.channel === 'foo') {
                await wait(50);
                wasKickOutCalled = true;
                socket.kickOut('foo', 'Socket was kicked out of the channel');
              }
            }
          })();
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      client.subscribe('foo');

      await wait(100);
      assert.equal(errorList.length, 0);
      assert.equal(wasKickOutCalled, true);
      assert.equal(serverSocket.channelSubscriptionsCount, 0);
      assert.equal(Object.keys(serverSocket.channelSubscriptions).length, 0);
    });

    it('Socket channelSubscriptions and channelSubscriptionsCount should update when socket.kickOut() is called without arguments', async function () {
      portNumber++;

      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      var errorList = [];
      var serverSocket;
      var wasKickOutCalled = false;

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          serverSocket = socket;

          (async () => {
            for await (let {error} of socket.listener('error')) {
              errorList.push(error);
            }
          })();

          (async () => {
            for await (let packet of socket.listener('subscribe')) {
              if (socket.channelSubscriptionsCount === 2) {
                await wait(50);
                wasKickOutCalled = true;
                socket.kickOut();
              }
            }
          })();
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      client.subscribe('foo');
      client.subscribe('bar');

      await wait(200);
      assert.equal(errorList.length, 0);
      assert.equal(wasKickOutCalled, true);
      assert.equal(serverSocket.channelSubscriptionsCount, 0);
      assert.equal(Object.keys(serverSocket.channelSubscriptions).length, 0);
    });
  });

  describe('Socket destruction', function () {
    it('Server socket destroy should disconnect the socket', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          await wait(100);
          socket.destroy(1000, 'Custom reason');
        }
      })();

      await server.listener('ready').once();

      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      let {code, reason} = await client.listener('disconnect').once();
      assert.equal(code, 1000);
      assert.equal(reason, 'Custom reason');
      assert.equal(server.clientsCount, 0);
      assert.equal(server.pendingClientsCount, 0);
    });

    it('Server socket destroy should set the active property on the socket to false', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });

      var serverSocket;

      (async () => {
        for await (let {socket} of server.listener('connection')) {
          serverSocket = socket;
          assert.equal(socket.active, true);
          await wait(100);
          socket.destroy();
        }
      })();

      await server.listener('ready').once();
      client = socketCluster.create({
        hostname: clientOptions.hostname,
        port: portNumber,
        multiplex: false
      });

      await client.listener('disconnect').once();
      assert.equal(serverSocket.active, false);
    });
  });

  describe('Socket Ping/pong', function () {
    describe('When when pingTimeoutDisabled is not set', function () {
      beforeEach('Launch server with ping options before start', async function () {
        portNumber++;
        // Intentionally make pingInterval higher than pingTimeout, that
        // way the client will never receive a ping or send back a pong.
        server = socketClusterServer.listen(portNumber, {
          authKey: serverOptions.authKey,
          wsEngine: WS_ENGINE,
          pingInterval: 2000,
          pingTimeout: 500
        });

        await server.listener('ready').once();
      });

      afterEach('Shut down server afterwards', async function () {
        destroyTestCase();
        server.close();
      });

      it('Should disconnect socket if server does not receive a pong from client before timeout', async function () {
        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        var serverWarning = null;
        (async () => {
          for await (let {warning} of server.listener('warning')) {
            serverWarning = warning;
          }
        })();

        var serverDisconnectionCode = null;
        (async () => {
          for await (let packet of server.listener('disconnection')) {
            serverDisconnectionCode = packet.code;
          }
        })();

        var clientError = null;
        (async () => {
          for await (let {error} of client.listener('error')) {
            clientError = error;
          }
        })();

        var clientDisconnectCode = null;
        (async () => {
          for await (let packet of client.listener('disconnect')) {
            clientDisconnectCode = packet.code;
          }
        })();

        await wait(1000);
        assert.notEqual(clientError, null);
        assert.equal(clientError.name, 'SocketProtocolError');
        assert.equal(clientDisconnectCode, 4001);

        assert.notEqual(serverWarning, null);
        assert.equal(serverWarning.name, 'SocketProtocolError');
        assert.equal(serverDisconnectionCode, 4001);
      });
    });

    describe('When when pingTimeoutDisabled is true', function () {
      beforeEach('Launch server with ping options before start', async function () {
        portNumber++;
        // Intentionally make pingInterval higher than pingTimeout, that
        // way the client will never receive a ping or send back a pong.
        server = socketClusterServer.listen(portNumber, {
          authKey: serverOptions.authKey,
          wsEngine: WS_ENGINE,
          pingInterval: 2000,
          pingTimeout: 500,
          pingTimeoutDisabled: true
        });

        await server.listener('ready').once();
      });

      afterEach('Shut down server afterwards', async function () {
        destroyTestCase();
        server.close();
      });

      it('Should not disconnect socket if server does not receive a pong from client before timeout', async function () {
        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false,
          pingTimeoutDisabled: true
        });

        var serverWarning = null;
        (async () => {
          for await (let {warning} of server.listener('warning')) {
            serverWarning = warning;
          }
        })();

        var serverDisconnectionCode = null;
        (async () => {
          for await (let packet of server.listener('disconnection')) {
            serverDisconnectionCode = packet.code;
          }
        })();

        var clientError = null;
        (async () => {
          for await (let {error} of client.listener('error')) {
            clientError = error;
          }
        })();

        var clientDisconnectCode = null;
        (async () => {
          for await (let packet of client.listener('disconnect')) {
            clientDisconnectCode = packet.code;
          }
        })();

        await wait(1000);
        assert.equal(clientError, null);
        assert.equal(clientDisconnectCode, null);

        assert.equal(serverWarning, null);
        assert.equal(serverDisconnectionCode, null);
      });
    });
  });

  describe('Middleware', function () {
    var middlewareFunction;
    var middlewareWasExecuted = false;

    beforeEach('Launch server without middleware before start', async function () {
      portNumber++;
      server = socketClusterServer.listen(portNumber, {
        authKey: serverOptions.authKey,
        wsEngine: WS_ENGINE
      });
      await server.listener('ready').once();
    });

    afterEach('Shut down server afterwards', async function () {
      destroyTestCase();
      server.close();
    });

    describe('MIDDLEWARE_AUTHENTICATE', function () {
      it('Should not run authenticate middleware if JWT token does not exist', async function () {
        middlewareFunction = async function (req) {
          middlewareWasExecuted = true;
        };
        server.addMiddleware(server.MIDDLEWARE_AUTHENTICATE, middlewareFunction);

        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        await client.listener('connect').once();
        assert.notEqual(middlewareWasExecuted, true);
      });

      it('Should run authenticate middleware if JWT token exists', async function () {
        global.localStorage.setItem('socketCluster.authToken', validSignedAuthTokenBob);

        middlewareFunction = async function (req) {
          middlewareWasExecuted = true;
        };
        server.addMiddleware(server.MIDDLEWARE_AUTHENTICATE, middlewareFunction);

        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        (async () => {
          try {
            await client.invoke('login', {username: 'bob'});
          } catch (err) {}
        })();

        await client.listener('authenticate').once();
        assert.equal(middlewareWasExecuted, true);
      });
    });

    describe('MIDDLEWARE_HANDSHAKE_SC', function () {
      it('Should trigger correct events if MIDDLEWARE_HANDSHAKE_SC blocks with an error', async function () {
        var middlewareWasExecuted = false;
        var serverWarnings = [];
        var clientErrors = [];
        var abortStatus;

        middlewareFunction = async function (req) {
          await wait(100);
          middlewareWasExecuted = true;
          var err = new Error('SC handshake failed because the server was too lazy');
          err.name = 'TooLazyHandshakeError';
          throw err;
        };
        server.addMiddleware(server.MIDDLEWARE_HANDSHAKE_SC, middlewareFunction);

        (async () => {
          for await (let {warning} of server.listener('warning')) {
            serverWarnings.push(warning);
          }
        })();

        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        (async () => {
          for await (let {error} of client.listener('error')) {
            clientErrors.push(error);
          }
        })();

        (async () => {
          let packet = await client.listener('connectAbort').once();
          abortStatus = packet.code;
        })();

        await wait(200);
        assert.equal(middlewareWasExecuted, true);
        assert.notEqual(clientErrors[0], null);
        assert.equal(clientErrors[0].name, 'TooLazyHandshakeError');
        assert.notEqual(clientErrors[1], null);
        assert.equal(clientErrors[1].name, 'SocketProtocolError');
        assert.notEqual(serverWarnings[0], null);
        assert.equal(serverWarnings[0].name, 'TooLazyHandshakeError');
        assert.notEqual(abortStatus, null);
      });

      it('Should send back default 4008 status code if MIDDLEWARE_HANDSHAKE_SC blocks without providing a status code', async function () {
        var middlewareWasExecuted = false;
        var abortStatus;
        var abortReason;

        middlewareFunction = async function (req) {
          await wait(100);
          middlewareWasExecuted = true;
          var err = new Error('SC handshake failed because the server was too lazy');
          err.name = 'TooLazyHandshakeError';
          throw err;
        };
        server.addMiddleware(server.MIDDLEWARE_HANDSHAKE_SC, middlewareFunction);

        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        (async () => {
          let packet = await client.listener('connectAbort').once();
          abortStatus = packet.code;
          abortReason = packet.reason;
        })();

        await wait(200);
        assert.equal(middlewareWasExecuted, true);
        assert.equal(abortStatus, 4008);
        assert.equal(abortReason, 'TooLazyHandshakeError: SC handshake failed because the server was too lazy');
      });

      it('Should send back custom status code if MIDDLEWARE_HANDSHAKE_SC blocks by providing a status code', async function () {
        var middlewareWasExecuted = false;
        var abortStatus;
        var abortReason;

        middlewareFunction = async function (req) {
          await wait(100);
          middlewareWasExecuted = true;
          var err = new Error('SC handshake failed because of invalid query auth parameters');
          err.name = 'InvalidAuthQueryHandshakeError';
          // Set custom 4501 status code as a property of the error.
          // We will treat this code as a fatal authentication failure on the front end.
          // A status code of 4500 or higher means that the client shouldn't try to reconnect.
          err.statusCode = 4501;
          throw err;
        };
        server.addMiddleware(server.MIDDLEWARE_HANDSHAKE_SC, middlewareFunction);

        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        (async () => {
          let packet = await client.listener('connectAbort').once();
          abortStatus = packet.code;
          abortReason = packet.reason;
        })();

        await wait(200);
        assert.equal(middlewareWasExecuted, true);
        assert.equal(abortStatus, 4501);
        assert.equal(abortReason, 'InvalidAuthQueryHandshakeError: SC handshake failed because of invalid query auth parameters');
      });

      it('Should connect with a delay if next() is called after a timeout inside the middleware function', async function () {
        var createConnectionTime = null;
        var connectEventTime = null;
        var abortStatus;
        var abortReason;

        middlewareFunction = async function (req) {
          await wait(500);
        };
        server.addMiddleware(server.MIDDLEWARE_HANDSHAKE_SC, middlewareFunction);

        createConnectionTime = Date.now();
        client = socketCluster.create({
          hostname: clientOptions.hostname,
          port: portNumber,
          multiplex: false
        });

        (async () => {
          let packet = await client.listener('connectAbort').once();
          abortStatus = packet.code;
          abortReason = packet.reason;
        })();

        await client.listener('connect').once();
        connectEventTime = Date.now();
        assert.equal(connectEventTime - createConnectionTime > 400, true);
      });
    });
  });
});
