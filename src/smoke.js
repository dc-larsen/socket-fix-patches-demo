// Exercises every route so CI can show that the app still behaves identically
// after Socket Patches rewrites the lockfile. No network egress: the one
// outbound route is skipped unless SMOKE_ALLOW_NETWORK=1.
'use strict';

const assert = require('node:assert');
const http = require('node:http');
const app = require('./server');

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const server = app.listen(0);
const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err.message });
  }
}

(async () => {
  await check('GET / renders a handlebars template', async () => {
    const res = await request('GET', '/?args=--verbose');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /Socket remediation demo/);
  });

  await check('GET /expand expands a brace pattern', async () => {
    const res = await request('GET', '/expand?pattern=src/{a,b}/index.js');
    assert.strictEqual(res.status, 200);
    const { expanded } = JSON.parse(res.body);
    assert.deepStrictEqual(expanded, ['src/a/index.js', 'src/b/index.js']);
  });

  await check('POST /config parses JSON5 and merges defaults', async () => {
    const res = await request('POST', '/config', { json5: "{ retries: 5, /* relaxed */ }" });
    assert.strictEqual(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.retries, 5);
    assert.strictEqual(parsed.timeoutMs, 5000);
  });

  await check('GET /compatible evaluates a semver range', async () => {
    const res = await request('GET', '/compatible?range=%5E1.0.0&version=1.4.0');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).compatible, true);
  });

  await check('GET /token signs and verifies a JWT', async () => {
    const res = await request('GET', '/token');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).decoded.sub, 'demo-user');
  });

  await check('POST /xml parses an XML document', async () => {
    const res = await request('POST', '/xml', { xml: '<root><item>one</item></root>' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body).parsed.root.item, ['one']);
  });

  await check('GET /state serializes server state', async () => {
    const res = await request('GET', '/state');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /window\.__STATE__ = \{"ok":true\}/);
  });

  if (process.env.SMOKE_ALLOW_NETWORK === '1') {
    await check('GET /fetch performs an outbound request', async () => {
      const res = await request('GET', '/fetch?url=https://example.com');
      assert.strictEqual(res.status, 200);
    });
  }

  server.close();

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? 'pass' : 'FAIL'}  ${c.name}${c.error ? ` — ${c.error}` : ''}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
