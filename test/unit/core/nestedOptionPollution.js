import assert from 'assert';
import http from 'http';
import axios from '../../../index.js';
import resolveConfig from '../../../lib/helpers/resolveConfig.js';

// Read-side prototype pollution gadgets for the bodyless method aliases and for
// nested option objects (`auth`, `paramsSerializer`). Axios does not create the
// pollution; these tests pin that an already polluted Object.prototype cannot
// change what a request sends.

const pollute = (values, fn) => {
  const keys = Object.keys(values);

  keys.forEach((key) => {
    Object.defineProperty(Object.prototype, key, {
      value: values[key],
      configurable: true,
      writable: true,
      enumerable: false
    });
  });

  const restore = () => keys.forEach((key) => delete Object.prototype[key]);

  let result;

  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }

  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { restore(); return value; },
      (err) => { restore(); throw err; }
    );
  }

  restore();

  return result;
};

const capturingAdapter = (captured) => (config) => {
  captured.config = config;

  return Promise.resolve({
    data: '',
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
    request: {}
  });
};

// resolveConfig builds the Basic header with btoa, a global only from Node 16 on
// (the browser and fetch adapters that call it run where btoa exists).
const skipWithoutBtoa = (ctx) => {
  if (typeof btoa !== 'function') {
    ctx.skip();
  }
};

describe('core::nested option pollution', function () {
  describe('bodyless method aliases', function () {
    ['get', 'delete', 'head', 'options'].forEach((method) => {
      it('should not read an inherited data value for axios.' + method + '()', async function () {
        const captured = {};

        await pollute({ data: 'EVILBODY' }, () =>
          axios[method]('http://localhost/x', { adapter: capturingAdapter(captured) })
        );

        assert.strictEqual(captured.config.data, undefined);
      });
    });

    it('should still pass an own data value on bodyless aliases', async function () {
      const captured = {};

      await axios.delete('http://localhost/x', { data: { own: 1 }, adapter: capturingAdapter(captured) });

      // JSON-transformed by transformRequest before it reaches the adapter
      assert.strictEqual(captured.config.data, '{"own":1}');
    });
  });

  describe('auth', function () {
    const basic = (username, password) => 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

    it('should ignore inherited username/password for an empty auth object in resolveConfig', function () {
      skipWithoutBtoa(this);

      const clean = resolveConfig({ url: 'http://localhost/x', auth: {} }).headers.get('Authorization');

      const polluted = pollute({ username: 'evil', password: 'pw' }, () =>
        resolveConfig({ url: 'http://localhost/x', auth: {} }).headers.get('Authorization')
      );

      assert.strictEqual(polluted, clean);
      assert.notStrictEqual(polluted, basic('evil', 'pw'));
    });

    it('should keep honoring own username/password in resolveConfig', function () {
      skipWithoutBtoa(this);

      const header = pollute({ username: 'evil', password: 'pw' }, () =>
        resolveConfig({ url: 'http://localhost/x', auth: { username: 'me', password: 'secret' } })
          .headers.get('Authorization')
      );

      assert.strictEqual(header, basic('me', 'secret'));
    });

    it('should ignore inherited username/password for an empty auth object in the http adapter', async function () {
      const seen = [];
      const server = http.createServer((req, res) => {
        seen.push(req.headers.authorization);
        res.end('ok');
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

      try {
        const url = 'http://127.0.0.1:' + server.address().port + '/';

        await axios.get(url, { proxy: false, auth: {} });

        await pollute({ username: 'evil', password: 'pw' }, () =>
          axios.get(url, { proxy: false, auth: {} })
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }

      assert.strictEqual(seen.length, 2);
      assert.strictEqual(seen[1], seen[0]);
      assert.notStrictEqual(seen[1], basic('evil', 'pw'));
    });
  });

  describe('paramsSerializer', function () {
    it('should ignore an inherited serialize function for an empty paramsSerializer object', function () {
      const uri = pollute({ serialize: () => 'evil=1' }, () =>
        axios.getUri({ url: '/x', params: { a: 1 }, paramsSerializer: {} })
      );

      assert.strictEqual(uri, '/x?a=1');
    });

    it('should ignore an inherited encode function for an empty paramsSerializer object', function () {
      const uri = pollute({ encode: () => 'EVIL' }, () =>
        axios.getUri({ url: '/x', params: { a: 1 }, paramsSerializer: {} })
      );

      assert.strictEqual(uri, '/x?a=1');
    });

    it('should keep honoring an own serialize function', function () {
      const uri = axios.getUri({
        url: '/x',
        params: { a: 1 },
        paramsSerializer: { serialize: () => 'mine=1' }
      });

      assert.strictEqual(uri, '/x?mine=1');
    });
  });
});
