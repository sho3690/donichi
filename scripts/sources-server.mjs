// GitHub Actions 側で投稿の本文を取る（Instagram / Threads / その他のサイト / TikTok の短縮リンク）。
// 受け取った URL しか開かない。名前を引いて社内・自分自身などの宛先になるものは、転送の途中も含めて開かない。

import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { clientFetchers, parseInstagram, parseThreads, parseGeneric } from '../sources.js';
import { parseUrl } from '../logic.js';

const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAX_BYTES = 1_500_000;
const MAX_HOPS = 5;

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

export async function safeTarget(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  if (u.port && !['80', '443'].includes(u.port)) return false;
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') || net.isIP(host.replace(/^\[|\]$/g, ''))) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) return false;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
  } catch { return false; }
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
    if (total >= MAX_BYTES) { await reader.cancel(); break; }
  }
  const buf = new Uint8Array(Math.min(total, MAX_BYTES));
  let off = 0;
  for (const c of chunks) { const n = Math.min(c.length, buf.length - off); buf.set(c.subarray(0, n), off); off += n; if (off >= buf.length) break; }
  return new TextDecoder().decode(buf);
}

async function getHtml(url, ua, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!(await safeTarget(current))) throw new Error('blocked target');
      const res = await fetch(current, { headers: { 'User-Agent': ua, 'Accept-Language': 'ja,en;q=0.8', Accept: 'text/html' }, redirect: 'manual', signal: ctl.signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { await res.body?.cancel(); current = new URL(loc, current).href; continue; }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
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
