// Lightweight HEAD-request link validation, run before publishing so a dead
// link surfaces as a warning instead of silently going live broken.

const https = require('https');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = 5000;

function checkOne(urlString) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (_) {
      return resolve({ url: urlString, ok: false, reason: 'Invalid URL' });
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search, port: parsed.port, timeout: TIMEOUT_MS },
      (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ url: urlString, ok, status: res.statusCode });
        res.resume();
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ url: urlString, ok: false, reason: 'Timed out' });
    });
    req.on('error', (err) => {
      resolve({ url: urlString, ok: false, reason: err.message });
    });
    req.end();
  });
}

async function checkAll(urls) {
  const unique = [...new Set(urls)];
  return Promise.all(unique.map(checkOne));
}

function extractUrls(entities, buttons) {
  const urls = [];
  for (const e of entities || []) {
    if (e.type === 'text_link' && e.url) urls.push(e.url);
  }
  for (const row of buttons || []) {
    for (const btn of row) {
      if (btn.url) urls.push(btn.url);
    }
  }
  return urls;
}

module.exports = { checkAll, extractUrls };
