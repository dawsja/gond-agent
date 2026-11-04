'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { createProxy, allowedAddress, allowedHostname, targetURL, LIMITS } = require('./proxy.cjs');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return server.address().port;
}
function request(proxy, url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxy.url, { path: url, agent: false, ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

test('IP policy rejects private, metadata, transition and ambiguous addresses, but permits loopback and public unicast', () => {
  for (const address of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '192.0.2.1', '192.88.99.1', '198.51.100.1', '203.0.113.1', '2001:db8::1', '2001:2::1', '3fff::1', '224.0.0.1', '239.1.2.3', '255.255.255.255', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', 'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '64:ff9b::a00:1', '2002:7f00:1::', '2001:0:ffff::1', '::1%lo', '127.1', 'garbage']) assert.equal(allowedAddress(address), false, address);
  for (const address of ['127.0.0.1', '127.255.0.1', '::1', '0:0:0:0:0:0:0:1', '1.1.1.1', '8.8.8.8', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(allowedAddress(address), true, address);
  for (const host of ['metadata', 'metadata.google.internal', 'x.metadata.google.internal', 'instance-data', 'metadata.azure.internal', 'metadata.goog', 'instance-data.ec2.internal']) assert.equal(allowedHostname(host), false, host);
  for (const url of ['file:///tmp/a', 'https://example.com', 'http://user:pass@example.com', 'http://example.com/#secret', 'http://a\\@b/', 'http://a/\r\nX:bad']) assert.throws(() => targetURL(url));
  assert.equal(targetURL('http://2130706433').hostname, '127.0.0.1');
  for (const authority of ['user@localhost:443', 'localhost:443/path', 'localhost:443?x=y', '::1:443', 'localhost', 'localhost:99999']) assert.throws(() => targetURL(authority, true));
});

test('HTTP proxy pins one DNS result to the socket and rechecks redirects and every destination', async (t) => {
  const seen = [];
  const port = await fixture(t, (req, res) => {
    seen.push({ host: req.headers.host, authorization: req.headers['proxy-authorization'] });
    if (req.url === '/redirect') res.writeHead(302, { Location: 'http://private.test/secret' }).end();
    else res.end('fixture');
  });
  const lookups = [];
  const proxy = await createProxy({ resolver: async (host) => {
    lookups.push(host);
    return [{ address: host === 'private.test' || lookups.filter((h) => h === host).length > 1 ? '10.0.0.1' : '127.0.0.1', family: 4 }];
  } });
  t.after(() => proxy.close());
  assert.equal((await request(proxy, `http://pin.test:${port}/`, { headers: { 'proxy-authorization': 'secret' } })).body, 'fixture');
  assert.deepEqual(lookups, ['pin.test']);
  assert.deepEqual(seen, [{ host: `pin.test:${port}`, authorization: undefined }]);
  // A new request cannot reuse an earlier DNS decision or a pooled socket.
  assert.equal((await request(proxy, `http://pin.test:${port}/`)).status, 403);
  const redirect = await request(proxy, `http://redirect.test:${port}/redirect`);
  assert.equal(redirect.status, 302);
  assert.equal((await request(proxy, redirect.headers.location)).status, 403);
  assert.equal(seen.length, 2);
  for (const target of [`http://127.0.0.1:8787/`, `http://[::1]:8788/`, 'http://metadata.google.internal/', 'http://169.254.169.254/']) assert.equal((await request(proxy, target)).status, 403);
  assert.equal((await request(proxy, proxy.url)).status, 403);
  assert.equal((await request(proxy, `http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-length': LIMITS.body + 1 } })).status, 403);
  await assert.rejects(request(proxy, `http://127.0.0.1:${port}/`, { headers: { 'x-padding': 'x'.repeat(LIMITS.headers) } }));
  assert.equal((await request(proxy, `http://127.0.0.1:${port}/`)).body, 'fixture');
});

test('mixed safe/private DNS answers fail closed', async (t) => {
  const port = await fixture(t, (_req, res) => { assert.fail('No private or mixed destination should be contacted'); res.end(); });
  const proxy = await createProxy({ resolver: async () => [{ address: '127.0.0.1', family: 4 }, { address: '192.168.0.2', family: 4 }] });
  t.after(() => proxy.close());
  assert.equal((await request(proxy, `http://mixed.test:${port}/`)).status, 403);
});

test('CONNECT pins DNS, tunnels bytes, blocks control/private ports, and closes live tunnels on shutdown', async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  const clients = [];
  t.after(() => { for (const client of clients) client.destroy(); return new Promise((resolve) => echo.close(resolve)); });
  let lookups = 0;
  const proxy = await createProxy({ resolver: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
  t.after(() => proxy.close());
  const connect = (authority) => new Promise((resolve, reject) => {
    const req = http.request(proxy.url, { method: 'CONNECT', path: authority, agent: false });
    req.on('connect', (res, socket, head) => { clients.push(socket); resolve({ res, socket, head }); });
    req.on('error', reject); req.end();
  });
  const tunnel = await connect(`pin.test:${echo.address().port}`);
  assert.equal(tunnel.res.statusCode, 200); assert.equal(lookups, 1);
  tunnel.socket.write('hello');
  assert.equal((await once(tunnel.socket, 'data'))[0].toString(), 'hello');
  for (const authority of ['localhost:8787', '127.0.0.1:8788', '10.0.0.1:443', '[::ffff:127.0.0.1]:443', '169.254.169.254:80']) assert.equal((await connect(authority)).res.statusCode, 403);
  const ended = once(tunnel.socket, 'close');
  await proxy.close(); await ended;
});
