import assert from 'assert';
import http from 'http';
import http2 from 'http2';
import {Readable} from 'stream';
import axios from '../../../index.js';

// maxBodyLength must also bound streamed uploads on transports that do not
// enforce options.maxBodyLength themselves (HTTP/2) and on the fetch adapter
// (live ReadableStream bodies whose size cannot be known up front).

const CHUNK = 1024;

const chunkReadable = (count) => {
  let sent = 0;

  return new Readable({
    read() {
      this.push(sent++ < count ? Buffer.alloc(CHUNK, 97) : null);
    }
  });
};

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('adapters::maxBodyLength on streamed uploads', function () {
  describe('http adapter over HTTP/2', function () {
    let server;
    let received;
    let sessions;

    beforeEach(async function () {
      received = 0;
      sessions = [];
      server = http2.createServer();

      server.on('session', (session) => sessions.push(session));

      server.on('stream', (stream) => {
        stream.on('data', (chunk) => {
          received += chunk.length;
        });
        stream.on('end', () => {
          stream.respond({':status': 200});
          stream.end('ok');
        });
        stream.on('error', () => {});
      });

      await listen(server);
    });

    afterEach(async function () {
      // the client keeps pooled HTTP/2 sessions open; close() waits for them
      sessions.forEach((session) => session.destroy());
      await close(server);
    });

    it('should reject a streamed upload larger than maxBodyLength', async function () {
      const url = 'http://127.0.0.1:' + server.address().port + '/';

      await assert.rejects(
        axios.post(url, chunkReadable(2048), {
          httpVersion: 2,
          maxBodyLength: CHUNK,
          headers: {'Content-Type': 'application/octet-stream'}
        }),
        (err) => {
          assert.strictEqual(err.code, 'ERR_BAD_REQUEST');
          return true;
        }
      );

      await delay(100);

      assert.ok(received < 2048 * CHUNK, 'the oversized stream must not be fully transmitted, got ' + received);
    });

    it('should allow a streamed upload within maxBodyLength', async function () {
      const url = 'http://127.0.0.1:' + server.address().port + '/';

      const res = await axios.post(url, chunkReadable(16), {
        httpVersion: 2,
        maxBodyLength: 64 * CHUNK,
        headers: {'Content-Type': 'application/octet-stream'}
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(received, 16 * CHUNK);
    });
  });

  describe('fetch adapter', function () {
    let server;
    let received;

    before(function () {
      if (typeof fetch !== 'function' || typeof ReadableStream !== 'function') {
        this.skip();
      }
    });

    beforeEach(async function () {
      received = 0;
      server = http.createServer((req, res) => {
        req.on('data', (chunk) => {
          received += chunk.length;
        });
        req.on('end', () => res.end('ok'));
        req.on('error', () => {});
      });

      await listen(server);
    });

    afterEach(async function () {
      await close(server);
    });

    const readableStream = (count) => {
      let sent = 0;

      return new ReadableStream({
        pull(controller) {
          if (sent++ < count) {
            controller.enqueue(new Uint8Array(CHUNK).fill(97));
          } else {
            controller.close();
          }
        }
      });
    };

    it('should not transmit a live ReadableStream body larger than maxBodyLength', async function () {
      const url = 'http://127.0.0.1:' + server.address().port + '/';

      await assert.rejects(
        axios.post(url, readableStream(2048), {
          adapter: 'fetch',
          maxBodyLength: CHUNK,
          headers: {'Content-Type': 'application/octet-stream'}
        }),
        (err) => {
          // ERR_BAD_REQUEST when the stream is counted, ERR_NOT_SUPPORT on a runtime
          // whose fetch cannot take stream bodies (fail closed, never an unbounded upload).
          assert.ok(['ERR_BAD_REQUEST', 'ERR_NOT_SUPPORT'].includes(err.code), 'unexpected code ' + err.code);
          return true;
        }
      );

      await delay(100);

      assert.ok(received < 2048 * CHUNK, 'the oversized stream must not be fully transmitted, got ' + received);
    });

    it('should allow a live ReadableStream body within maxBodyLength', async function () {
      const url = 'http://127.0.0.1:' + server.address().port + '/';

      let res;

      try {
        res = await axios.post(url, readableStream(16), {
          adapter: 'fetch',
          maxBodyLength: 64 * CHUNK,
          headers: {'Content-Type': 'application/octet-stream'}
        });
      } catch (err) {
        if (err.code === 'ERR_NOT_SUPPORT') {
          this.skip();
        }
        throw err;
      }

      assert.strictEqual(res.status, 200);
      assert.strictEqual(received, 16 * CHUNK);
    });
  });
});
