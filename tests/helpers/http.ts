import * as http from 'http';
import { AddressInfo } from 'net';
import { afterAll } from 'vitest';
import supertest from 'supertest';

/*
 * Use this `request` instead of supertest's own: `import request from './helpers/http'`.
 *
 * Given an app, supertest starts a fresh server for every request on
 * `listen(0)`, which binds the dual-stack wildcard `::`, and then connects to
 * 127.0.0.1. macOS can hand that wildcard socket a port another process
 * already holds on 127.0.0.1 (a dev proxy, another test run's mock), and the
 * IPv4 connect then goes to that process instead. Tests saw this as
 * "socket hang up", ECONNRESET, "Parse Error: Expected HTTP/", or a response
 * from some other server.
 *
 * Here every app is served by one server per test file, bound to 127.0.0.1,
 * which the kernel never gives a port that is already taken there. Each app
 * gets a path prefix, so the test server routes the request to it with the
 * URL the app expects.
 */

const PREFIX = '/__test-app/';
const apps = new Map<string, http.RequestListener>();
const ids = new WeakMap<http.RequestListener, string>();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  const id = url.slice(PREFIX.length).split(/[/?]/, 1)[0];
  const app = url.startsWith(PREFIX) ? apps.get(id) : undefined;
  if (!app) {
    res.writeHead(404).end(`no test app for ${url}`);
    return;
  }
  req.url = url.slice(PREFIX.length + id.length) || '/';
  app(req, res);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(
  () =>
    new Promise<void>(resolve => {
      apps.clear();
      server.close(() => resolve());
    }),
);

/** supertest's `request`, with apps served from the shared loopback server. */
function request(app: http.RequestListener | http.Server | string): ReturnType<typeof supertest> {
  if (typeof app !== 'function') return supertest(app);
  let id = ids.get(app);
  if (!id) {
    id = String(nextId++);
    ids.set(app, id);
    apps.set(id, app);
  }
  return supertest(`${base}${PREFIX}${id}`);
}

// So `request.Response` still names supertest's response type.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace request {
  export type Response = supertest.Response;
}

export default request;
