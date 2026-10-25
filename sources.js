// 投稿の本文（キャプション・説明欄）を取ってくる。
// TikTok / X / YouTube は公開の窓口（oEmbed）がブラウザから使えるので、追加したその場で取る。
// Instagram / Threads はブラウザからは取れないため、GitHub Actions（scripts/sources-server.mjs）が取る。

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
  const f = clientFetchers[item.platform];
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

// Instagram: og:title は「名前 on Instagram: "本文"」、og:description は「n likes, n comments - user on 日付: "本文".」
export function parseInstagram(html) {
  const meta = metaTags(html);
  let text = '', author = '';
  const t = meta['og:title'] || '';
  let m = t.match(/^(.*?) on Instagram: ["“]([\s\S]*)["”]\s*$/);
  if (m) { author = m[1].trim(); text = m[2]; }
  if (!text) {
    const d = meta['og:description'] || meta.description || '';
    m = d.match(/^[\s\S]*? - ([^\s]+) on [^:]+: ["“]([\s\S]*)["”]\.?\s*$/) || d.match(/^[\s\S]*?: ["“]([\s\S]*)["”]\.?\s*$/);
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

// Threads: og:description が本文、og:title は「名前 (@user) on Threads」
export function parseThreads(html) {
  const meta = metaTags(html);
  const text = meta['og:description'] || '';
  if (!text) return null;
  const author = (meta['og:title'] || '').replace(/\s*on Threads\s*$/, '').trim();
  return { author, text, title: '', thumb: meta['og:image'] || '', via: 'threads' };
}

export function parseGeneric(html) {
  const meta = metaTags(html);
  const tt = between(String(html), String(html).toLowerCase(), 0, '<title', '</title>', 2000);
  const title = meta['og:title'] || meta['twitter:title'] || (tt ? tt.inner : '');
  const text = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  if (!title && !text) return null;
  return { author: meta['og:site_name'] || '', text: decodeEntities(text), title: decodeEntities(title).trim(), thumb: meta['og:image'] || '', via: 'web' };
}
