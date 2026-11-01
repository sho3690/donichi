// 土日 DONICHI — 入れるだけのページ（drop.html）。合言葉なしで、ストックに入れることだけができる（中は見えない）。
// ChatGPT の dots など、自分のブラウザを持つ AI が開いて入れられるように。
// リンク: drop.html#w=<受け口>&as=<だれが行きたい（メンバー名）>&by=<どこから（例: ChatGPT）>&u=<リンク>&n=<メモ>
//   （u と n は省いて、開いてから書いてもよい）
import { findUrls, parseUrl, clip, PLATFORM_LABEL, DROP_MAX_ITEMS } from './logic.js';
import { dropSeal, dropTag, b64u } from './crypto.js';
import { publish, MAX_BODY } from './relay.js';

const $ = s => document.querySelector(s);
const form = $('#drop-form'), links = $('#u'), note = $('#n'), go = $('#go'), err = $('#u-err'), result = $('#result'), problem = $('#problem');
const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

function showProblem(title, text, retry = false) {
  form.hidden = true;
  problem.hidden = false;
  problem.replaceChildren(el('h2', { textContent: title }), el('p', { textContent: text }));
  if (retry) problem.append(el('button', { className: 'btn btn-secondary', type: 'button', textContent: '開き直す', onclick: () => location.reload() }));
}
function fieldError(msg) {
  err.hidden = !msg; err.textContent = msg;
  if (msg) { links.setAttribute('aria-invalid', 'true'); links.focus(); } else links.removeAttribute('aria-invalid');
}

// 同じ中身を同じ1時間のうちに二度送っても、ストックには1つだけ入る（押し直し・開き直しで二重にならない）
async function dropId(...parts) {
  const src = new TextEncoder().encode([...parts, Math.floor(Date.now() / 3600000)].join('\n'));
  return b64u.enc(new Uint8Array(await crypto.subtle.digest('SHA-256', src))).slice(0, 22);
}

// リンクごとに1件。リンクが無ければ、書いたものをメモとして1件（メモは最初の1件に付ける）
function toItems(linkText, memo) {
  const urls = findUrls(linkText).filter(u => u.length <= 2000 && parseUrl(u));
  if (!urls.length) {
    const text = [linkText.trim(), memo].filter(Boolean).join('\n');
    return text ? [{ url: '', note: text }] : [];
  }
  return urls.map((url, i) => ({ url, note: i === 0 ? memo : '' }));
}
const label = x => {
  if (!x.url) return clip(x.note, 60);
  const p = parseUrl(x.url);
  return `${PLATFORM_LABEL[p?.platform] || 'Web'}: ${clip(x.url.replace(/^https?:\/\/(www\.)?/, ''), 50)}`;
};

async function main() {
  // 他のサイトの枠（iframe）の中では開かない
  if (window.top !== window.self) { document.body.textContent = ''; return; }
  const q = new URLSearchParams(location.hash.slice(1));
  const w = q.get('w') || '';
  const by = (q.get('by') || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const as = (q.get('as') || '').trim().slice(0, 24);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(w)) return showProblem('このリンクでは入れられません', 'リンクが途中で切れているようです。土日の「設定」にある「ChatGPT などから入れる」のリンクを、そのまま使ってください。');

  let cfg, drop;
  try {
    [cfg, drop] = await Promise.all(['./config.json', './drop.json'].map(u => fetch(u, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })));
  } catch { return showProblem('読み込めませんでした', '電波の良い所で、開き直してください。', true); }
  if (!drop?.pub || drop.tag !== await dropTag(w)) return showProblem('このリンクは使えなくなっています', 'リンクが作り直されたか、途中で切れています。土日の「設定」から新しいリンクをもらってください。');

  links.value = (q.get('u') || '').slice(0, 6000);
  note.value = (q.get('n') || '').slice(0, 1500);
  form.hidden = false;
  links.addEventListener('input', () => { fieldError(''); result.hidden = true; });
  if (!links.value) links.focus();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (go.disabled) return;
    const memo = note.value.trim();
    const items = toItems(links.value, memo);
    if (!items.length) return fieldError('リンクかメモのどちらかを入れてください');
    if (items.length > DROP_MAX_ITEMS) return fieldError(`一度に入れられるのは${DROP_MAX_ITEMS}件までです。分けて入れてください`);
    fieldError('');
    go.disabled = true; go.classList.add('loading');
    try {
      const body = await dropSeal(drop.pub, { v: 1, id: await dropId(w, by, as, memo, links.value.trim()), items, by, as });
      if (body.length > MAX_BODY) { fieldError('長すぎて送れません。メモを短くするか、分けて入れてください'); return; }
      let sent = false;
      for (const wait of [0, 1500, 4000]) {
        if (wait) await new Promise(r => setTimeout(r, wait));
        try { await publish(cfg.relay, w, body); sent = true; break; } catch { /* もう一度 */ }
      }
      if (!sent) { fieldError('送れませんでした。電波を確かめて、もう一度「ストックに入れる」を押してください'); return; }
      links.value = ''; note.value = '';
      result.hidden = false;
      const list = el('ul');
      list.append(...items.map(x => el('li', { textContent: label(x) })));
      result.replaceChildren(
        el('p', { className: 'drop-done', textContent: `ストックに入れました（${items.length}件）` }),
        list,
        el('p', { className: 'help', textContent: '日付や場所は、15分ほどで投稿から読み取られます。続けて入れるときは、また貼って押してください。' }));
      result.scrollIntoView({ block: 'nearest' });
    } finally { go.disabled = false; go.classList.remove('loading'); }
  });
}

main();
