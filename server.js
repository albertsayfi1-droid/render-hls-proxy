import { Readable } from 'node:stream';

// Change these URLs to streams you own or are authorized to relay.
const CHANNELS = {
  '1': 'https://dev.morvilantera.shop/ytv/671f54c2734546f6/index.m3u8',
  '2': 'https://dev.morvilantera.shop/ytv/39325e5ccff84cef/index.m3u8'
};
const ALLOWED_HOSTS = new Set(Object.values(CHANNELS).map(x => new URL(x).hostname));
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Origin not allowed');
  return url;
}
function encode(url) { return Buffer.from(url).toString('base64url'); }
function decode(token) {
  if (!/^[a-zA-Z0-9_-]{1,4096}$/.test(token)) throw new Error('Invalid token');
  return Buffer.from(token, 'base64url').toString('utf8');
}
function proxyUri(uri, base) {
  if (/^(data:|skd:|blob:)/i.test(uri)) return uri;
  const target = safeUrl(new URL(uri, base).href);
  return '/hls/p/' + encode(target.href);
}
function rewritePlaylist(text, base) {
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_whole, uri) => `URI="${proxyUri(uri, base)}"`);
    }
    return proxyUri(line.trim(), base);
  }).join('\n');
}
async function fetchAllowed(initial, headers) {
  let url = safeUrl(initial);
  for (let i = 0; i < 5; i++) {
    const upstream = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if ([301,302,303,307,308].includes(upstream.status)) {
      const loc = upstream.headers.get('location');
      if (!loc) throw new Error('Invalid upstream redirect');
      url = safeUrl(new URL(loc, url).href);
      await upstream.body?.cancel();
      continue;
    }
    return { upstream, finalUrl: url };
  }
  throw new Error('Too many upstream redirects');
}
async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end('Method not allowed');
  try {
    const resource = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.replace(/^\/hls\/?/, '')).replace(/^\/+/, '');
    let url;
    if (/^[a-zA-Z0-9_-]+\.m3u8$/.test(resource) && CHANNELS[resource.slice(0,-5)]) {
      url = CHANNELS[resource.slice(0,-5)];
    } else if (resource.startsWith('p/')) {
      url = decode(resource.slice(2));
    } else {
      return res.writeHead(404).end('Unknown channel');
    }
    safeUrl(url);
    const requestHeaders = {};
    if (req.headers.range) requestHeaders.range = req.headers.range;
    // Use a stable, transparent proxy user-agent; do not attempt to evade provider protections.
    requestHeaders['user-agent'] = 'AuthorizedHLSProxy/1.0';
    const { upstream, finalUrl } = await fetchAllowed(url, requestHeaders);
    res.statusCode = upstream.status;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    for (const h of ['content-range', 'accept-ranges', 'content-length']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const type = upstream.headers.get('content-type') || '';
    const isPlaylist = finalUrl.pathname.toLowerCase().endsWith('.m3u8') || /mpegurl/i.test(type);
    if (isPlaylist && upstream.ok && req.method === 'GET') {
      res.removeHeader('content-length');
      const raw = await upstream.arrayBuffer();
      if (raw.byteLength > MAX_PLAYLIST_BYTES) return res.writeHead(502).end('Playlist too large');
      const output = rewritePlaylist(Buffer.from(raw).toString('utf8'), finalUrl);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.end(output);
    }
    res.setHeader('Content-Type', type || 'application/octet-stream');
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    console.error('Proxy error:', e.message);
    if (!res.headersSent) res.writeHead(502).end('Upstream unavailable');
  }
}

import http from 'node:http';
const port = Number(process.env.PORT || 10000);
http.createServer((req,res) => {
  if (!new URL(req.url, 'http://localhost').pathname.startsWith('/hls/')) { res.writeHead(404).end('Not found'); return; }
  handler(req,res).catch(err => { console.error(err); if (!res.headersSent) res.writeHead(500).end('Server error'); });
}).listen(port, '0.0.0.0', () => console.log('HLS proxy listening on', port));
