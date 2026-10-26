// GitHub Actions 側で投稿の本文を取る（Instagram / Threads / その他のサイト / TikTok の短縮リンク）。
// 受け取った URL しか開かない。名前を引いて社内・自分自身などの宛先になるものは、転送の途中も含めて開かない。

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { clientFetchers, parseInstagram, parseThreads, parseGeneric, parseYouTube, parseYouTubeApi, parseGsi, parseGsiArea, parseWikiPage } from '../sources.js';
import { parseUrl, imageQueries } from '../logic.js';

// 名乗りは正直に（他社のクローラーやブラウザのふりをしない）。断られたら、画面でキャプションを貼ってもらう
const UA = 'DONICHI/1.0 (+https://sho3690.github.io/donichi/)';
export const TIKTOK_NO_TEXT = 'TikTok は投稿の本文を外から読めません';
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

// 転送をたどって、行き先が done(url) を満たした時点で止める（行き先のページ本体は読まない）
async function followTo(url, done, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (done(current)) return current;
      if (!shapeOk(current)) throw new Error('blocked target');
      const res = await request(current, UA, ctl.signal);
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { current = new URL(res.headers.location, current).href; continue; }
      return current;
    }
    throw new Error('too many redirects');
  } finally { clearTimeout(t); }
}

// YouTube の公式 API（鍵 YOUTUBE_API_KEY が Secrets にあるときだけ）。
// クラウドから動画ページを開くと確認用のページが返り説明欄が読めないため、説明欄はこれで取る。
// 鍵は URL に入れずヘッダーで渡す（エラー文やログに鍵が混ざらない）
async function youtubeApi(videoId) {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key || !/^[\w-]{11}$/.test(videoId)) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&hl=ja&id=${videoId}`,
      { headers: { 'X-Goog-Api-Key': key, 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`YouTube API ${res.status}`);
    return parseYouTubeApi(await res.json());
  } finally { clearTimeout(t); }
}

const isTikTokPost = u => { const p = parseUrl(u); return p?.platform === 'tiktok' && /\/(video|photo)\/\d+/.test(p.canonical); };

const serverFetchers = {
  async instagram(item) {
    const code = item.canonical.match(/\/p\/([^/]+)/)?.[1];
    const tries = [item.canonical, code && `https://www.instagram.com/p/${code}/embed/captioned/`].filter(Boolean);
    for (const url of tries) {
      try { const { html } = await getHtml(url, UA); const r = parseInstagram(html); if (r) return r; } catch { /* 次へ */ }
    }
    return null;
  },
  async threads(item) {
    const { html } = await getHtml(item.canonical, UA);
    return parseThreads(html);
  },
  // TikTok は本文を外から読めない（oEmbed が題名を返さず、ページは自動アクセスよけの仕組みで中身を出す）。
  // 短縮リンクの行き先と投稿者の名前（URL の @…）だけ取り、本文はすぐに「貼ってください」に回す
  async tiktok(item) {
    let target = item;
    if (!isTikTokPost(item.canonical)) {
      try {
        const to = await followTo(item.url || item.canonical, isTikTokPost);
        if (isTikTokPost(to)) { const p = parseUrl(to); target = { ...item, url: p.url, canonical: p.canonical }; }
      } catch { /* 行き先が分からなくても、貼ってもらえば読める */ }
    }
    const resolved = target !== item ? { url: target.url, canonical: target.canonical } : null;
    const got = await clientFetchers.tiktok(target).catch(() => null);
    if (got?.text) return { ...got, resolved };
    const handle = target.canonical.match(/tiktok\.com\/(@[^/]+)\//)?.[1] || '';
    return { author: got?.author || handle, text: '', title: '', thumb: got?.thumb || '', via: 'tiktok-link', resolved, giveUp: TIKTOK_NO_TEXT };
  },
  x: item => clientFetchers.x(item),
  async youtube(item) {
    try {
      const api = await youtubeApi(new URL(item.canonical).searchParams.get('v') || '');
      if (api) return api;
    } catch { /* 下の方法へ */ }
    const base = await clientFetchers.youtube(item).catch(() => null);
    try {
      const { html } = await getHtml(item.canonical, UA);
      const y = parseYouTube(html);
      if (y) return { ...y, author: base?.author || y.author, title: base?.title || y.title, thumb: base?.thumb || y.thumb };
    } catch { /* 題名だけでも十分 */ }
    return base;
  },
  async web(item) {
    const { html } = await getHtml(item.canonical, UA);
    return parseGeneric(html);
  },
};

export async function fetchOnServer(item) {
  const f = serverFetchers[item.platform];
  if (!f) return null;
  return f(item);
}

// ---- 位置と写真 ----
// 住所 → 国土地理院の住所検索で位置。施設名・題名・エリア → Wikipedia の記事の写真と位置。
// 行き先は決まった公的・公開の窓口だけ（受け取った URL は開かない）。名乗りは正直に。
async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
const gsi = q => getJson(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q.slice(0, 100))}`);
const wiki = title => getJson(`https://ja.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages%7Ccoordinates%7Cpageprops&piprop=thumbnail&pithumbsize=480&ppprop=disambiguation&titles=${encodeURIComponent(title.slice(0, 80))}`).then(parseWikiPage);

// center: 天気を見る地域の中心（エリア名だけのときに、遠くの同じ地名を拾わないため）
export async function locate(info, center) {
  let geo = null, image = null;
  const pages = {};
  for (const q of imageQueries(info)) {
    pages[q] = await wiki(q).catch(() => null);
    if (pages[q]?.thumb && !image) image = { url: pages[q].thumb, title: pages[q].title };
  }
  // 住所の位置は、答えの地名に住所の市区町村が入っているときだけ使う（住所でない文を引いて、都庁の位置などが返るのを防ぐ）
  const muni = String(info.address || '').match(/^(?:東京都|北海道|京都府|大阪府|[\u4e00-\u9fff]{2,3}県)?(.+?[市区町村])/)?.[1];
  if (info.address && muni) geo = parseGsi(await gsi(info.address).catch(() => null), { must: muni });
  for (const q of Object.keys(pages)) if (!geo && q !== info.area && pages[q]?.geo) geo = pages[q].geo;   // 施設の記事の位置
  if (!geo && info.area) geo = parseGsiArea(await gsi(info.area).catch(() => null), info.area, center) || pages[info.area]?.geo || null;
  return { geo, image };
}
