// Minimal Express app whose dependencies are intentionally pinned to vulnerable
// versions. The point is that these packages are actually imported and called,
// so a scan sees real usage rather than an unused dependency list.
//
// The dependency set is chosen so both remediation phases have work to do.
// Most packages have a minor or patch upgrade available, which Socket Fix
// takes. A few have no upgrade short of a major bump, or no upgrade at all
// (xmldom, ip, serialize-javascript, tar), and only a Socket patch closes them.
'use strict';

const express = require('express');
const axios = require('axios');
const braces = require('braces');
const handlebars = require('handlebars');
const ip = require('ip');
const JSON5 = require('json5');
const jwt = require('jsonwebtoken');
const _ = require('lodash');
const minimist = require('minimist');
const semver = require('semver');
const serialize = require('serialize-javascript');
const xml2js = require('xml2js');
const { DOMParser } = require('xmldom');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(express.json());

const template = handlebars.compile('<h1>{{title}}</h1><p>{{count}} records</p>');
const jar = new CookieJar();
const SECRET = process.env.DEMO_JWT_SECRET || 'demo-only-not-a-real-secret';

app.get('/', (req, res) => {
  const args = minimist(req.query.args ? String(req.query.args).split(' ') : []);
  res.type('html').send(
    template({ title: 'Socket remediation demo', count: Object.keys(args).length })
  );
});

// braces: brace-pattern expansion for a path filter
app.get('/expand', (req, res) => {
  const pattern = String(req.query.pattern || 'src/{a,b}/*.js');
  res.json({ pattern, expanded: braces.expand(pattern) });
});

// json5 + lodash: parse a relaxed config document and merge it over defaults
app.post('/config', (req, res) => {
  const defaults = { retries: 3, timeoutMs: 5000 };
  const incoming = typeof req.body.json5 === 'string' ? JSON5.parse(req.body.json5) : {};
  res.json(_.merge({}, defaults, incoming));
});

// semver: range check against a requested version
app.get('/compatible', (req, res) => {
  const range = String(req.query.range || '^1.0.0');
  const version = String(req.query.version || '1.2.3');
  res.json({ range, version, compatible: semver.satisfies(version, range) });
});

// jsonwebtoken: issue and verify a token
app.get('/token', (req, res) => {
  const token = jwt.sign({ sub: 'demo-user' }, SECRET, { expiresIn: '5m' });
  res.json({ token, decoded: jwt.verify(token, SECRET) });
});

// xml2js: parse an XML payload into plain objects
app.post('/xml', async (req, res) => {
  try {
    const parsed = await xml2js.parseStringPromise(String(req.body.xml || '<root/>'));
    res.json({ parsed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// xmldom: DOM-style XML parsing, counting elements with a given tag name
app.post('/xml/dom', (req, res) => {
  const xml = String(req.body.xml || '<root/>');
  const tag = String(req.body.tag || 'item');
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(xml, 'text/xml');
  res.json({ tag, count: doc.getElementsByTagName(tag).length });
});

// ip: classify an address as private or public
app.get('/ip', (req, res) => {
  const address = String(req.query.address || req.ip || '127.0.0.1');
  res.json({ address, private: ip.isPrivate(address), public: ip.isPublic(address) });
});

// serialize-javascript: embed server state into a page
app.get('/state', (req, res) => {
  res.type('html').send(`<script>window.__STATE__ = ${serialize({ ok: true })}</script>`);
});

// axios + tough-cookie: outbound fetch through a cookie jar
app.get('/fetch', async (req, res) => {
  const url = String(req.query.url || 'https://example.com');
  try {
    const response = await axios.get(url, { timeout: 3000 });
    await jar.setCookie(`last=${Date.now()}; Path=/`, 'https://example.com');
    res.json({ status: response.status, bytes: String(response.data).length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`demo app listening on http://localhost:${port}`));
}

module.exports = app;
