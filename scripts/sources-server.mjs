// GitHub Actions 側で投稿の本文を取る（Instagram / Threads / その他のサイト / TikTok の短縮リンク）。
// 受け取った URL しか開かない。社内ネットワークや IP 直書きの宛先は開かない。

import { clientFetchers, parseInstagram, parseThreads, parseGeneric } from '../sources.js';
import { parseUrl } from '../logic.js';

const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAX_BYTES = 3_000_000;

function safeTarget(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.port && !['80', '443'].includes(u.port)) return false;
  const h = u.hostname;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false;
  return true;
}

async function getHtml(url, ua, timeout = 12000) {
  if (!safeTarget(url)) throw new Error('blocked target');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'ja,en;q=0.8', Accept: 'text/html' }, redirect: 'follow', signal: ctl.signal });
    if (!safeTarget(res.url)) throw new Error('blocked redirect');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { html: new TextDecoder().decode(buf.subarray(0, MAX_BYTES)), finalUrl: res.url };
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
