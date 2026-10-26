// 投稿の本文（キャプション・説明欄）を取ってくる。
// X / YouTube は公開の窓口（oEmbed）がブラウザから使えるので、追加したその場で取る。
// TikTok の oEmbed は 2026年に題名（本文）を返さなくなった。戻ったときのために試すだけ試す。
// Instagram / Threads / YouTube の説明欄 / 一般のサイトは、GitHub Actions（scripts/sources-server.mjs）が取る。

import { htmlToText, decodeEntities } from './logic.js';

async function getJson(url, timeout = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// 位置を進めながら読むだけの小さな道具。どんな入力でも長さに比例した時間で終わる（正規表現の暴走を避ける）
function between(html, lower, start, open, close, max) {
  const i = lower.indexOf(open, start);
  if (i < 0) return null;
  const j = lower.indexOf('>', i);
  if (j < 0) return null;
  const k = lower.indexOf(close, j + 1);
  if (k < 0 || k - j > max) return null;
  return { inner: html.slice(j + 1, k), head: html.slice(i, j + 1), end: k };
}

export function parseXOembed(j) {
  const html = String(j?.html || '').slice(0, 50000);
  const p = between(html, html.toLowerCase(), 0, '<p', '</p>', 20000);
  const text = p ? htmlToText(p.inner).replace(/\s*pic\.(twitter|x)\.com\/\S+/g, '').trim() : '';
  return text ? { author: j.author_name || '', text, title: '', thumb: '', via: 'x-oembed' } : null;
}

export const clientFetchers = {
  async tiktok(item) {
    const j = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(item.url || item.canonical)}`);
    if (!j?.title && !j?.author_name) return null;
    return { author: j.author_name || '', text: j.title || '', title: '', thumb: j.thumbnail_url || '', via: 'tiktok-oembed' };
  },
  async x(item) {
    try {
      const r = parseXOembed(await getJson(`https://publish.x.com/oembed?url=${encodeURIComponent(item.canonical)}&omit_script=1&lang=ja&dnt=true`));
      if (r) return r;
    } catch { /* 下の予備へ */ }
    const m = item.canonical.match(/x\.com\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const j = await getJson(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`);
    const tw = j?.tweet;
    if (!tw) return null;
    const media = tw.media?.photos?.[0]?.url || tw.media?.videos?.[0]?.thumbnail_url || '';
    return { author: tw.author?.name || m[1], text: tw.text || '', title: '', thumb: media, via: 'fxtwitter' };
  },
  async youtube(item) {
    const j = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(item.canonical)}&format=json`);
    if (!j?.title) return null;
    return { author: j.author_name || '', text: '', title: j.title, thumb: j.thumbnail_url || '', via: 'youtube-oembed' };
  },
};

export async function fetchInBrowser(item) {
  const f = item.platform === 'tiktok' ? null : clientFetchers[item.platform];   // TikTok はブラウザからは何も取れない（サーバーで行き先と名前だけ取る）
  if (!f) return null;
  try { return await f(item); } catch { return null; }
}

// ---- HTML の解析（サーバー側で使う。テストしやすいようここに置く） ----
export function metaTags(html) {
  const out = {};
  html = String(html);
  const lower = html.toLowerCase();
  for (let pos = 0; ;) {
    const i = lower.indexOf('<meta', pos);
    if (i < 0) break;
    const j = lower.indexOf('>', i);
    if (j < 0) break;
    pos = j + 1;
    if (j - i > 20000) continue;
    const tag = html.slice(i, j + 1);
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']{1,100})["']/i) || [])[1];
    const val = (tag.match(/content\s*=\s*"([^"]*)"/i) || tag.match(/content\s*=\s*'([^']*)'/i) || [])[1];
    if (key && val != null && !(key.toLowerCase() in out)) out[key.toLowerCase()] = decodeEntities(val);
  }
  return out;
}

// Instagram: og:title は「名前 - Instagram: "本文"」（以前は「名前 on Instagram: "本文"」）、
// og:description は「日付、n likes, n comments - user: "本文".」（以前は「… - user on 日付: "本文".」）
export function parseInstagram(html) {
  const meta = metaTags(html);
  let text = '', author = '';
  const t = meta['og:title'] || '';
  let m = t.match(/^(.*?)\s+(?:on|-|–)\s+Instagram\s*[:：]\s*["“]([\s\S]*)["”]\s*$/);
  if (m) { author = m[1].trim(); text = m[2]; }
  if (!text) {
    const d = meta['og:description'] || meta.description || '';
    m = d.match(/^[\s\S]*? - (\S+?)(?: on [^:：]+)?\s*[:：]\s*["“]([\s\S]*)["”]\.?\s*$/) || d.match(/^[\s\S]*?[:：]\s*["“]([\s\S]*)["”]\.?\s*$/);
    if (m) { if (m.length === 3) { author = author || m[1]; text = m[2]; } else text = m[1]; }
  }
  if (!text) {   // 埋め込みページ（/embed/captioned/）の本文
    const h = String(html), lower = h.toLowerCase();
    const at = lower.indexOf('class="caption"');
    const c = at >= 0 ? between(h, lower, lower.lastIndexOf('<', at), '<', '</div>', 30000) : null;
    if (c) {
      let inner = c.inner;
      const cut = inner.indexOf('<div class="CaptionComments"');
      if (cut >= 0) inner = inner.slice(0, cut);
      const ua = inner.indexOf('class="CaptionUsername"');
      if (ua >= 0) {
        const gt = inner.indexOf('>', ua), endA = inner.indexOf('</a>', ua);
        if (gt >= 0 && endA > gt) { author = author || inner.slice(gt + 1, endA).trim(); inner = inner.slice(0, inner.lastIndexOf('<', ua)) + inner.slice(endA + 4); }
      }
      text = htmlToText(inner).replace(/\s*(View all|コメント\d|すべてのコメント)[\s\S]*$/, '').trim();
    }
  }
  if (!text) return null;
  return { author, text: text.trim(), title: '', thumb: meta['og:image'] || '', via: 'instagram' };
}

// Threads: og:description が本文、og:title は「名前 (@user) on Threads」（日本語のページでは「Threadsの名前 (@user)」）
export function parseThreads(html) {
  const meta = metaTags(html);
  const text = meta['og:description'] || '';
  if (!text) return null;
  const author = (meta['og:title'] || '').replace(/^Threads\s*の\s*/, '').replace(/\s*on Threads\s*$/, '').trim();
  return { author, text, title: '', thumb: meta['og:image'] || '', via: 'threads' };
}

// ページに埋め込まれた JSON の文字列 "key":"…" を1つ取り出す（前から順に読むだけ。長さに比例した時間で終わる）
export function jsonStringAt(html, key, max = 20000) {
  const s = String(html);
  const at = s.indexOf(`"${key}":"`);
  if (at < 0) return '';
  const start = at + key.length + 4;
  let i = start;
  for (; i < s.length && i - start < max; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') break;
  }
  if (s[i] !== '"') return '';
  try { return JSON.parse(`"${s.slice(start, i)}"`); } catch { return ''; }
}

// YouTube: og:description は途中で切れているので、ページの中の説明欄の全文（shortDescription）を使う。
// クラウドから開くと確認用のページが返ることがあり、そのときの説明は YouTube 全体の決まり文句なので捨てる
const YT_GENERIC = /^(YouTube でお気に入りの動画や音楽を楽しみ|Enjoy the videos and music you love)/;
export function parseYouTube(html) {
  const meta = metaTags(html);
  const t = meta['og:title'] || meta['twitter:title'] || '';
  const title = t === 'YouTube' ? '' : t;
  const d = meta['og:description'] || meta.description || '';
  const text = jsonStringAt(html, 'shortDescription') || (YT_GENERIC.test(d) ? '' : d);
  if (!title && !text) return null;
  return { author: jsonStringAt(html, 'ownerChannelName', 200), text, title, thumb: meta['og:image'] || '', via: 'youtube' };
}

// YouTube Data API v3（videos.list, part=snippet）の答え。題名・説明欄の全文・チャンネル名・サムネイル
export function parseYouTubeApi(j) {
  const sn = Array.isArray(j?.items) ? j.items[0]?.snippet : null;
  if (!sn || typeof sn !== 'object') return null;
  const loc = sn.localized && typeof sn.localized === 'object' ? sn.localized : {};
  const title = String(loc.title || sn.title || '');
  const text = String(loc.description || sn.description || '');
  if (!title && !text) return null;
  const th = sn.thumbnails || {};
  const thumb = String((th.high || th.medium || th.default || {}).url || '');
  return { author: String(sn.channelTitle || ''), title, text, thumb, via: 'youtube-api' };
}

// お店・イベントのサイトが埋め込んでいる構造化データ（schema.org の JSON-LD）を、読み取りやすい行にする
const LD_MAX_BLOCKS = 6;
const LD_MAX_CHARS = 100000;
function* ldNodes(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 6) return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 50)) yield* ldNodes(x, depth + 1); return; }
  yield v;
  if (v['@graph']) yield* ldNodes(v['@graph'], depth + 1);
}
const ldText = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, 200);
const ldTypes = n => [].concat(n['@type'] || []).filter(t => typeof t === 'string');
const ldDate = v => { const m = ldText(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
function ldAddress(a) {
  if (typeof a === 'string') return ldText(a);
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '';
  return [a.postalCode && `〒${ldText(a.postalCode).replace(/^〒/, '')}`, a.addressRegion, a.addressLocality, a.streetAddress].map(ldText).filter(Boolean).join(' ');
}
function ldPrice(n) {
  if (n.isAccessibleForFree === true) return '無料';
  const o = [].concat(n.offers || [])[0];
  if (o && typeof o === 'object') {
    const p = ldText(o.price ?? o.lowPrice);
    if (p === '0') return '無料';
    if (p) return /JPY/i.test(ldText(o.priceCurrency)) || !o.priceCurrency ? `${p}円` : `${p} ${ldText(o.priceCurrency)}`;
  }
  return ldText(n.priceRange);
}
export function jsonLdLines(html) {
  const s = String(html), lower = s.toLowerCase();
  const lines = [];
  for (let pos = 0, blocks = 0; blocks < LD_MAX_BLOCKS; blocks++) {
    const at = lower.indexOf('application/ld+json', pos);
    if (at < 0) break;
    const st = lower.lastIndexOf('<script', at);
    const b = st >= 0 ? between(s, lower, st, '<script', '</script>', LD_MAX_CHARS) : null;
    pos = b ? b.end : at + 19;
    if (!b) continue;
    let data;
    try { data = JSON.parse(b.inner); } catch { continue; }
    for (const n of ldNodes(data)) {
      const types = ldTypes(n);
      const isEvent = types.some(t => /Event$/.test(t) || t === 'Festival');
      const isPlace = types.some(t => /(LocalBusiness|Restaurant|Shop|Store|Bakery|BarOrPub|Museum|Attraction|Park|Place|Establishment|Center|Zoo|Aquarium|Gallery|Hotel|Venue)$/.test(t));
      if (!isEvent && !isPlace) continue;
      const name = ldText(n.name);
      if (isEvent) {
        const a = ldDate(n.startDate), z = ldDate(n.endDate);
        if (name) lines.push(`イベント: ${name}`);
        if (a) lines.push(z && z !== a ? `開催期間: ${a}〜${z}` : `開催日: ${a}`);
        const loc = [].concat(n.location || [])[0];
        if (loc && typeof loc === 'object') {
          if (ldText(loc.name)) lines.push(`会場: ${ldText(loc.name)}`);
          if (ldAddress(loc.address)) lines.push(`住所: ${ldAddress(loc.address)}`);
        } else if (ldText(loc)) lines.push(`会場: ${ldText(loc)}`);
      } else {
        if (name) lines.push(`店名: ${name}`);
        if (ldAddress(n.address)) lines.push(`住所: ${ldAddress(n.address)}`);
        const oh = [].concat(n.openingHours || []).map(ldText).filter(Boolean).join(' / ');
        if (oh) lines.push(`営業時間: ${oh}`);
      }
      const price = ldPrice(n);
      if (price) lines.push(`料金: ${price}`);
      if (lines.length >= 24) return [...new Set(lines)];
    }
  }
  return [...new Set(lines)];
}

export function parseGeneric(html) {
  const meta = metaTags(html);
  const tt = between(String(html), String(html).toLowerCase(), 0, '<title', '</title>', 2000);
  const title = meta['og:title'] || meta['twitter:title'] || (tt ? tt.inner : '');
  const desc = decodeEntities(meta['og:description'] || meta['twitter:description'] || meta.description || '');
  const text = [...jsonLdLines(html), desc].filter(Boolean).join('\n');
  if (!title && !text) return null;
  return { author: meta['og:site_name'] || '', text, title: decodeEntities(title).trim(), thumb: meta['og:image'] || '', via: 'web' };
}
