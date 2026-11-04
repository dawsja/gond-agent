'use strict';

// This is an egress filter, not a boundary against code running in the container.
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;

const BLOCKED_PORTS = new Set([8787, 8788]);
const LIMITS = Object.freeze({ sockets: 64, requests: 64, headers: 16384, body: 8 * 1024 * 1024, response: 64 * 1024 * 1024, timeout: 30000 });

function ipv6Number(address) {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':');
    const octets = value.slice(colon + 1).split('.').map(Number);
    value = value.slice(0, colon + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((n, group) => (n << 16n) | BigInt('0x' + group), 0n);
}

function allowedAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 127) return true;
    return !(a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113 || a >= 224);
  }
  if (family === 6) {
    const n = ipv6Number(address);
    if (n === 1n) return true;
    // Only global unicast. This also rejects mapped/compatible IPv4, NAT64,
    // ULA, link/site-local, multicast, unspecified and transition tunnels.
    // Also deny the special-purpose 2001::/23 block, documentation prefixes
    // 2001:db8::/32 and 3fff::/20, and deprecated 6to4 2002::/16.
    return n >> 125n === 1n && n >> 105n !== 0x100080n &&
      n >> 96n !== 0x20010db8n && n >> 112n !== 0x2002n && n >> 108n !== 0x3fff0n;
  }
  return false;
}

function hostnameOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function allowedHostname(host) {
  return host.length > 0 && host.length <= 253 && !host.includes('%') &&
    !/(^|\.)(metadata|instance-data)(\.|$)/.test(host) && host !== '169.254.169.254';
}

function targetURL(raw, connect = false) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(raw)) throw new Error('Blocked target');
  const url = new URL(connect ? 'http://' + raw : raw);
  if ((!connect && url.protocol !== 'http:') || url.username || url.password || url.hash ||
      connect && (url.pathname !== '/' || url.search || !/^([\w.-]+|\[[0-9a-fA-F:]+\]):[0-9]+$/.test(raw))) throw new Error('Blocked target');
  return url;
}

function deadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), ms); })]).finally(() => clearTimeout(timer));
}

function filteredHeaders(headers) {
  const skip = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of String(headers.connection || '').split(',')) skip.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !skip.has(name.toLowerCase())));
}

async function createProxy({ resolver = (host) => dns.lookup(host, { all: true, verbatim: true }) } = {}) {
  const sockets = new Set();
  const pendingDNS = new Set();
  let active = 0;
  let stopped = false;
  let ownPort;
  const server = http.createServer({ maxHeaderSize: LIMITS.headers, requestTimeout: LIMITS.timeout, headersTimeout: 10000 }, async (req, res) => {
    if (++active > LIMITS.requests || stopped) { active--; res.writeHead(503).end(); return; }
    let upstream;
    let done = false;
    const finish = () => { if (!done) { done = true; active--; upstream?.destroy(); } };
    res.on('close', finish);
    res.on('error', finish);
    req.on('error', () => { upstream?.destroy(); res.destroy(); });
    try {
      const url = targetURL(req.url);
      const target = await resolveTarget(url);
      if (res.destroyed || stopped) return;
      const length = req.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > LIMITS.body)) throw new Error('Body too large');
      const headers = filteredHeaders(req.headers);
      headers.host = url.host;
      upstream = http.request({ hostname: target.address, family: target.family, port: target.port, method: req.method,
        path: url.pathname + url.search, headers, agent: false, maxHeaderSize: LIMITS.headers }, (response) => {
        res.writeHead(response.statusCode, filteredHeaders(response.headers));
        let received = 0;
        response.on('data', (chunk) => { received += chunk.length; if (received > LIMITS.response) { response.destroy(); res.destroy(); } });
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('socket', (socket) => {
        if (stopped || sockets.size >= LIMITS.sockets) { socket.destroy(); return; }
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      upstream.setTimeout(LIMITS.timeout, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      req.on('aborted', () => upstream.destroy());
      let sent = 0;
      req.on('data', (chunk) => { sent += chunk.length; if (sent > LIMITS.body) { upstream.destroy(); res.destroy(); } });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(403, { Connection: 'close' }).end('Blocked browser destination');
      else res.destroy();
    }
  });

  async function resolveTarget(url) {
    const host = hostnameOf(url);
    const port = Number(url.port || 80);
    if (!allowedHostname(host) || !Number.isInteger(port) || port < 1 || port > 65535 || BLOCKED_PORTS.has(port)) throw new Error('Blocked target');
    const literal = net.isIP(host);
    let records;
    if (literal) records = [{ address: host, family: literal }];
    else {
      // Timed-out DNS calls cannot be cancelled by every resolver. Count them
      // until settlement so repeated timeouts cannot grow an unbounded backlog.
      if (pendingDNS.size >= LIMITS.requests) throw new Error('DNS limit');
      const lookup = Promise.resolve().then(() => resolver(host));
      pendingDNS.add(lookup);
      lookup.then(() => pendingDNS.delete(lookup), () => pendingDNS.delete(lookup));
      records = await deadline(lookup, 5000);
    }
    if (!Array.isArray(records) || records.length === 0 || records.length > 64 || records.some((r) => !allowedAddress(r.address))) throw new Error('Blocked address');
    const address = records[0].address;
    if (port === ownPort && (address.startsWith('127.') || address === '::1')) throw new Error('Proxy loop');
    // Never pass the original hostname to a socket or perform a second lookup.
    return { address, family: net.isIP(address), port };
  }

  server.on('connect', async (req, client, head) => {
    if (++active > LIMITS.requests || stopped) { active--; client.destroy(); return; }
    let upstream;
    let done = false;
    const finish = () => { if (!done) { done = true; active--; upstream?.destroy(); } };
    client.once('close', finish);
    try {
      const target = await resolveTarget(targetURL(req.url, true));
      if (client.destroyed || stopped) return;
      if (sockets.size >= LIMITS.sockets) throw new Error('Socket limit');
      upstream = net.connect({ host: target.address, port: target.port, family: target.family });
      sockets.add(upstream);
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      upstream.on('error', () => client.destroy());
      upstream.setTimeout(LIMITS.timeout, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  });
  server.on('connection', (socket) => {
    // At most one upstream for each admitted client socket (HTTP or CONNECT).
    if (stopped || sockets.size >= LIMITS.sockets) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(LIMITS.timeout, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  ownPort = server.address().port;
  return {
    url: `http://127.0.0.1:${ownPort}`,
    async close() {
      stopped = true;
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createProxy, allowedAddress, allowedHostname, targetURL, LIMITS };
