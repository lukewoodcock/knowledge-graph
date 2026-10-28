// shortlinks: POST /links {"url": "..."} returns a short code; GET /<code> redirects.
const http = require('http');
const { encode, decode } = require('./codes');

const links = new Map();
let counter = 0;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function createLink(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: 'Body must be JSON' });
  }
  let url;
  try {
    url = new URL(body.url);
  } catch {
    return send(res, 400, { error: 'url must be an absolute URL' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return send(res, 400, { error: 'url must be http or https' });
  }
  const id = counter++;
  links.set(id, url.href);
  send(res, 201, { code: encode(id), url: url.href });
}

function followLink(req, res) {
  const id = decode(req.url.slice(1));
  const target = id === null ? undefined : links.get(id);
  if (!target) return send(res, 404, { error: 'No such link' });
  res.writeHead(302, { Location: target });
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/links') return void createLink(req, res);
  if (req.method === 'GET' && req.url.length > 1) return followLink(req, res);
  send(res, 404, { error: 'Not found' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`shortlinks on http://localhost:${port}`));
}

module.exports = { server };
