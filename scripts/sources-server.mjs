// GitHub Actions 側で投稿の本文を取る（Instagram / Threads / その他のサイト / TikTok の短縮リンク）。
// 受け取った URL しか開かない。名前を引いて社内・自分自身などの宛先になるものは、転送の途中も含めて開かない。

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { clientFetchers, parseInstagram, parseThreads, parseGeneric } from '../sources.js';
import { parseUrl } from '../logic.js';

const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAX_BYTES = 1_500_000;
const MAX_HOPS = 5;

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
      || (a === 192 && b === 0 && c === 0) || (a === 168 && b === 63 && c === 129 && d === 16);   // 168.63.129.16 = クラウドの内部向け
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b');
  }
  return true;
}

// URL の形だけで断れるもの
function shapeOk(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  if (u.port && !['80', '443'].includes(u.port)) return false;
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') || net.isIP(host.replace(/^\[|\]$/g, ''))) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host);
}

// 接続するその瞬間に名前を引いて確かめる（確かめた後で宛先を差し替える手口も防ぐ）
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { family: options?.family || 0, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    if (options?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  });
}

export async function safeTarget(url) {
  if (!shapeOk(url)) return false;
  return new Promise(res => guardedLookup(new URL(url).hostname.replace(/\.$/, ''), {}, err => res(!err)));
}

function request(url, ua, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { headers: { 'User-Agent': ua, 'Accept-Language': 'ja,en;q=0.8', Accept: 'text/html' }, lookup: guardedLookup, signal, timeout: 12000 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function readCapped(res) {
  const chunks = [];
  let total = 0;
  for await (const c of res) {
    chunks.push(c); total += c.length;
    if (total >= MAX_BYTES) { res.destroy(); break; }
  }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8');
}

async function getHtml(url, ua, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!shapeOk(current)) throw new Error('blocked target');
      const res = await request(current, ua, ctl.signal);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); current = new URL(res.headers.location, current).href; continue; }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
      return { html: await readCapped(res), finalUrl: current };
    }
    throw new Error('too many redirects');
  } finally { clearTimeout(t); }
}

const serverFetchers = {
  async instagram(item) {
    const code = item.canonical.match(/\/p\/([^/]+)/)?.[1];
    const tries = [
      [item.canonical, CRAWLER_UA],
      code && [`https://www.instagram.com/p/${code}/embed/captioned/`, MOBILE_UA],
    ].filter(Boolean);
    for (const [url, ua] of tries) {
      try { const { html } = await getHtml(url, ua); const r = parseInstagram(html); if (r) return r; } catch { /* 次へ */ }
    }
    return null;
  },
  async threads(item) {
    const { html } = await getHtml(item.canonical, CRAWLER_UA);
    return parseThreads(html);
  },
  async tiktok(item) {
    let target = item;
    if (item.short || !/\/(video|photo)\/\d+/.test(item.canonical)) {   // 短縮リンクは行き先を確かめる
      const { finalUrl } = await getHtml(item.url || item.canonical, MOBILE_UA);
      const p = parseUrl(finalUrl);
      if (p) target = { ...item, ...p };
    }
    return clientFetchers.tiktok(target);
  },
  x: item => clientFetchers.x(item),
  async youtube(item) {
    const base = await clientFetchers.youtube(item);
    try {
      const { html } = await getHtml(item.canonical, CRAWLER_UA);
      const g = parseGeneric(html);
      if (g?.text && base) base.text = g.text;
    } catch { /* 題名だけでも十分 */ }
    return base;
  },
  async web(item) {
    const { html } = await getHtml(item.canonical, CRAWLER_UA);
    return parseGeneric(html);
  },
};

export async function fetchOnServer(item) {
  const f = serverFetchers[item.platform];
  if (!f) return null;
  return f(item);
}
