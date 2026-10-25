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

export function parseXOembed(j) {
  const html = String(j?.html || '');
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  const text = p ? htmlToText(p[1]).replace(/\s*pic\.(twitter|x)\.com\/\S+/g, '').trim() : '';
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
  // 長さに上限のある素直な正規表現だけを使う（巨大なページで固まらないように）
  for (const m of String(html).matchAll(/<meta\s[^>]{0,20000}>/gi)) {
    const tag = m[0];
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
    const c = String(html).match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/);
    if (c) {
      const raw = htmlToText(c[1].replace(/<a[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/, '').replace(/<div class="CaptionComments"[\s\S]*$/, ''));
      text = raw.replace(/\s*(View all|コメント\d|すべてのコメント)[\s\S]*$/, '').trim();
    }
    const u = String(html).match(/class="CaptionUsername"[^>]*>([^<]+)</);
    if (u) author = author || u[1].trim();
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
  const title = meta['og:title'] || meta['twitter:title'] || (String(html).match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  const text = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  if (!title && !text) return null;
  return { author: meta['og:site_name'] || '', text: decodeEntities(text), title: decodeEntities(title).trim(), thumb: meta['og:image'] || '', via: 'web' };
}
