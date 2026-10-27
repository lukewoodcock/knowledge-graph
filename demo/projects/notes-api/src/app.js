// notes-api: POST /notes, GET /notes, GET /notes/<id>.
const http = require('http');
const store = require('./store');

const MAX_BODY = 64 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY) reject(Object.assign(new Error('too large'), { status: 413 }));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        reject(Object.assign(err, { status: 400 }));
      }
    });
  });
}

async function createNote(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return send(res, err.status || 400, { error: err.status === 413 ? 'Body too large' : 'Body must be JSON' });
  }
  if (typeof body.title !== 'string' || !body.title.trim()) return send(res, 400, { error: 'title is required' });
  send(res, 201, store.create({ title: body.title.trim(), body: String(body.body ?? '') }));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/notes') return void createNote(req, res);
  if (req.method === 'GET' && req.url === '/notes') return send(res, 200, store.list());
  const match = /^\/notes\/([\w-]+)$/.exec(req.url);
  if (req.method === 'GET' && match) {
    const note = store.get(match[1]);
    return note ? send(res, 200, note) : send(res, 404, { error: 'No such note' });
  }
  send(res, 404, { error: 'Not found' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 4000;
  server.listen(port, () => console.log(`notes-api on http://localhost:${port}`));
}

module.exports = { server };
