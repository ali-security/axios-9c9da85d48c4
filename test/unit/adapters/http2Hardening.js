import assert from 'assert';
import http2 from 'http2';
import net from 'net';
import axios from '../../../index.js';

// The HTTP/2 transport must honor the configured DNS `lookup`, and a failing
// HTTP/2 session must not surface as an unhandled 'error' event that takes the
// process down.

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('adapters::http2 hardening', function () {
  describe('session errors', function () {
    let bad;

    beforeEach(async function () {
      // Accepts a TCP connection and resets it: the HTTP/2 session fails during setup.
      bad = net.createServer((socket) => socket.destroy());
      await listen(bad);
    });

    afterEach(async function () {
      await close(bad);
    });

    it('should reject the request without an unhandled session error', async function () {
      // An unhandled 'error' on the ClientHttp2Session is rethrown as an uncaught
      // exception, which mocha reports against this test. TLS is used so the
      // reset surfaces as a session error during setup.
      await assert.rejects(
        axios.get('https://127.0.0.1:' + bad.address().port + '/', {
          httpVersion: 2,
          timeout: 5000,
          http2Options: {rejectUnauthorized: false}
        })
      );

      await delay(200);
    });
  });

  describe('lookup', function () {
    let server;
    let hits;
    let sessions;

    beforeEach(async function () {
      hits = 0;
      sessions = [];
      server = http2.createServer();

      server.on('session', (session) => sessions.push(session));

      server.on('stream', (stream) => {
        hits++;
        stream.respond({':status': 200});
        stream.end('ok');
      });

      await listen(server);
    });

    afterEach(async function () {
      // the client keeps pooled HTTP/2 sessions open; close() waits for them
      sessions.forEach((session) => session.destroy());
      await close(server);
    });

    it('should use the configured lookup to resolve the host', async function () {
      let calls = 0;
      const lookup = (hostname, options, cb) => {
        calls++;
        cb(null, '127.0.0.1', 4);
      };

      const res = await axios.get('http://lookup-test.invalid:' + server.address().port + '/', {
        httpVersion: 2,
        lookup,
        timeout: 5000
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(calls, 1);
      assert.strictEqual(hits, 1);
    });

    it('should keep reusing the pooled session for repeated requests with the same lookup', async function () {
      let calls = 0;
      const lookup = (hostname, options, cb) => {
        calls++;
        cb(null, '127.0.0.1', 4);
      };
      const url = 'http://lookup-reuse.invalid:' + server.address().port + '/';

      await axios.get(url, {httpVersion: 2, lookup, timeout: 5000});
      await axios.get(url, {httpVersion: 2, lookup, timeout: 5000});

      assert.strictEqual(hits, 2);
      assert.strictEqual(calls, 1, 'the second request should reuse the session instead of resolving again');
    });
  });
});
