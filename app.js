// 土日 DONICHI — 画面。データは「保存済みのスナップショット」＋「中継に届いた変更」を合わせて表示する。
import * as L from './logic.js';
import { keysFrom, deriveMaster, seal, open, b64u } from './crypto.js';
import { publish, poll, MAX_BODY } from './relay.js';
import { fetchInBrowser } from './sources.js';

const $ = (s, el = document) => el.querySelector(s);
const K = { master: 'donichi.master', name: 'donichi.name', cache: 'donichi.cache', outbox: 'donichi.outbox', sent: 'donichi.sent', wx: 'donichi.wx', filter: 'donichi.filter', seen: 'donichi.seen' };
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  json: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
};

// 鍵は「取り出せない形（non-extractable）」で IndexedDB に置き、親鍵そのものは保存しない。
// sho3690.github.io は他のアプリと同じ置き場なので、万一そちらに不正なスクリプトが入っても鍵を持ち出せないように。
const keyStore = {
  db: null,
  async open() {
    if (!this.db) this.db = await new Promise((res, rej) => { const r = indexedDB.open('donichi', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return this.db;
  },
  async req(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => { const tx = db.transaction('kv', mode); const q = fn(tx.objectStore('kv')); tx.oncomplete = () => res(q?.result); tx.onerror = () => rej(tx.error); });
  },
  get: k => keyStore.req('readonly', st => st.get(k)).catch(() => undefined),
  set: (k, v) => keyStore.req('readwrite', st => st.put(v, k)).then(() => true, () => false),
  del: k => keyStore.req('readwrite', st => st.delete(k)).catch(() => {}),
};

// ---- 小さな道具 ----
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'ic') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', `#i-${name}`);
  s.append(u); return s;
}
const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : b64u.enc(crypto.getRandomValues(new Uint8Array(16))));
const initial = name => [...String(name || '?').trim()][0] || '?';
const hm = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---- アプリの状態 ----
const app = {
  cfg: null, keys: null, name: '', snap: null, relay: new Map(), outbox: [], sent: [], st: null,
  view: 'weekend', filter: 'all', wx: {}, sheet: null, lastSnap: 0, lastPoll: 0, relayOk: true, snapOk: true, trigger: null, es: null,
};

// ================= 起動 =================
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  try { app.cfg = await (await fetch('./config.json', { cache: 'no-store' })).json(); }
  catch { return fatal('設定を読み込めませんでした。電波の良い所で開き直してください。'); }

  const hash = new URLSearchParams(location.hash.slice(1));
  const linkKey = hash.get('k');
  const joinPass = hash.get('join');
  if (linkKey || joinPass) history.replaceState(null, '', `${location.pathname}${location.search}#/weekend`);

  const legacy = ls.get(K.master);   // 以前の版が保存した親鍵は、取り出せない形に移してから消す
  const master = linkKey || (joinPass ? b64u.enc(await deriveMaster(joinPass, app.cfg.salt, app.cfg.iterations)) : null) || legacy;
  ls.del(K.master);
  if (master) {
    if (!(await useKey(master))) return showLock({ error: linkKey ? 'この招待リンクは使えなくなっています。新しいリンクをもらってください。' : '合言葉が変わりました。新しい招待リンクを開くか、合言葉を入れ直してください。' });
  } else {
    const saved = await keyStore.get('keys');
    if (saved && saved.check === app.cfg.check && saved.aes) app.keys = saved;
    else if (saved) { await keyStore.del('keys'); return showLock({ error: '合言葉が変わりました。新しい招待リンクを開くか、合言葉を入れ直してください。' }); }
  }
  if (!app.keys) return showLock();
  app.name = ls.get(K.name) || '';
  if (!app.name) return showLock({ nameOnly: true });
  start();
}

async function useKey(master) {
  try {
    const keys = await keysFrom(typeof master === 'string' ? b64u.dec(master) : master);   // 壊れたリンクでもここで止まらない
    if (keys.check !== app.cfg.check) return false;
    app.keys = keys;
    await keyStore.set('keys', { aes: keys.aes, topic: keys.topic, check: keys.check });   // 保存できない環境では、この画面を開いている間だけ使う
    return true;
  } catch { return false; }
}

function fatal(msg) {
  const root = $('#lock'); root.hidden = false; $('#shell').hidden = true;
  root.replaceChildren(h('div', { class: 'lock-card' }, brand(), h('h1', {}, '開けませんでした'), h('p', { class: 'lead' }, msg),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, '開き直す')));
}
const brand = () => h('div', { class: 'brand' }, h('span', { class: 'brand-ja' }, '土日'), h('span', { class: 'brand-en' }, 'DONICHI'));

// ---- 合言葉の画面 ----
function showLock({ error = '', nameOnly = false } = {}) {
  const root = $('#lock');
  root.hidden = false; $('#shell').hidden = true;
  const errPw = h('p', { class: 'err', id: 'pw-err', hidden: !error }, error);
  const pw = h('input', { class: 'input', id: 'pw', name: 'password', type: 'password', autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false', required: true, 'aria-describedby': 'pw-help pw-err', 'aria-invalid': error ? 'true' : null });
  const eye = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '合言葉を表示', 'aria-pressed': 'false', onclick: () => {
    const show = pw.type === 'password'; pw.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show)); eye.setAttribute('aria-label', show ? '合言葉を隠す' : '合言葉を表示');
  } }, icon('eye'));
  const errName = h('p', { class: 'err', id: 'name-err', hidden: true });
  const nameIn = h('input', { class: 'input', id: 'nm', name: 'nickname', type: 'text', autocomplete: 'nickname', maxlength: '12', required: true, value: ls.get(K.name) || '', 'aria-describedby': 'nm-help name-err' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'はじめる');

  const form = h('form', { novalidate: true, onsubmit: async e => {
    e.preventDefault();
    let bad = false;
    const name = nameIn.value.trim();
    errName.hidden = !!name; nameIn.setAttribute('aria-invalid', name ? 'false' : 'true');
    if (!name) { errName.textContent = '名前を入れてください（ストックした人の表示に使います）'; bad = true; }
    if (!nameOnly && !pw.value.trim()) { errPw.hidden = false; errPw.textContent = '合言葉を入れてください'; pw.setAttribute('aria-invalid', 'true'); bad = true; }
    if (bad) { (nameOnly || pw.value.trim() ? nameIn : pw).focus(); return; }
    if (!nameOnly) {
      submit.classList.add('loading'); submit.disabled = true;
      const ok = await useKey(await deriveMaster(pw.value, app.cfg.salt, app.cfg.iterations));
      submit.classList.remove('loading'); submit.disabled = false;
      if (!ok) {
        errPw.hidden = false; errPw.textContent = '合言葉が違います。招待してくれた人に確かめてください。';
        pw.setAttribute('aria-invalid', 'true'); pw.focus(); return;
      }
    }
    app.name = name; ls.set(K.name, name);
    start({ joined: true });
  } },
  !nameOnly && h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'donichi', hidden: true, readonly: true }),
  !nameOnly && h('div', { class: 'field' },
    h('label', { for: 'pw' }, '合言葉', h('span', { class: 'req', 'aria-hidden': 'true' }, '*')),
    h('div', { class: 'pw' }, pw, eye),
    h('p', { class: 'help', id: 'pw-help' }, '招待してくれた人から届いた合言葉です（例: abcde-fghjk-…）。招待リンクから開けば入力はいりません。'),
    errPw),
  h('div', { class: 'field' },
    h('label', { for: 'nm' }, 'あなたの名前', h('span', { class: 'req', 'aria-hidden': 'true' }, '*')),
    nameIn,
    h('p', { class: 'help', id: 'nm-help' }, 'だれがストックしたか・行きたいかの表示に使います。あとで変えられます。'),
    errName),
  submit);

  root.replaceChildren(h('div', { class: 'lock-card' }, brand(),
    h('h1', {}, nameOnly ? 'ようこそ' : '招待された人だけが使えます'),
    h('p', { class: 'lead' }, nameOnly
      ? 'みんなでストックしたお店やイベントを、毎週木曜の朝に今週末の予定として割り振ります。名前を入れてはじめましょう。'
      : 'Instagram や TikTok で見つけた行きたい所をストックすると、毎週木曜の朝に今週末の予定として自動で割り振ります。'),
    form,
    h('p', { class: 'note' }, 'データは合言葉で暗号化して保存しています。合言葉を知らない人には中身が見えません。')));
  (nameOnly ? nameIn : pw).focus();
}

// ================= 起動後 =================
function start({ joined = false } = {}) {
  $('#lock').hidden = true; $('#shell').hidden = false;
  app.outbox = [];
  app.sent = ls.json(K.sent, []);
  app.filter = ls.get(K.filter) || 'all';
  const wx = ls.json(K.wx, null);
  if (wx?.data) app.wx = wx.data;

  wire();
  loadOutbox().then(() => { if (app.outbox.length) { recompute(); flushOutbox(); } });
  route();
  const cached = ls.json(K.cache, null);
  if (cached?.sealed) open(app.keys, cached.sealed).then(s => { if (!app.snap) { app.snap = s; recompute(); } }).catch(() => {});
  if (joined) send('member.join');
  refresh().then(handleShare);
  loadWeather();
  listen();
  setInterval(tick, 30000);
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  document.addEventListener('click', onAction);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
  window.addEventListener('online', () => { flushOutbox(); tick(true); });
  const d = $('#sheet');
  d.addEventListener('close', () => { app.sheet = null; d.replaceChildren(); app.trigger?.focus?.({ preventScroll: true }); app.trigger = null; });
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
}

// ---- データの取得と合成 ----
async function fetchSnapshot() {
  const res = await fetch(`./data/state.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('snapshot');
  const file = await res.json();
  app.snap = file.sealed ? await open(app.keys, file.sealed) : L.emptyState();
  app.lastSnap = Date.now(); app.snapOk = true;
  ls.set(K.cache, JSON.stringify({ sealed: file.sealed, at: Date.now() }));
}

async function pollRelay() {
  const last = app.snap?.log?.lastTime || 0;
  const msgs = await poll(app.cfg.relay, app.keys.topic, last ? Math.max(0, last - 900) : 'all');
  for (const m of msgs) await addRelayMessage(m);
  app.lastPoll = Date.now(); app.relayOk = true;
}
async function addRelayMessage(m) {
  try {
    const ev = await open(app.keys, m.message);
    if (typeof ev?.id !== 'string') return false;
    ev.time = m.time;
    if (!app.relay.has(ev.id)) { app.relay.set(ev.id, ev); return true; }
  } catch { /* 他の鍵のメッセージや壊れたものは無視 */ }
  return false;
}

async function refresh() {
  try { await fetchSnapshot(); } catch { app.snapOk = false; }
  try { await pollRelay(); } catch { app.relayOk = false; }
  if (!app.snap) { render(); return; }
  // 保存済みに入った変更は中継の控えから外す
  const applied = new Set(app.snap.log.applied);
  for (const id of [...app.relay.keys()]) if (applied.has(id)) app.relay.delete(id);
  resendLost(applied);
  recompute();
  flushOutbox();
}

// 中継に送ったのに、保存にも中継にも見当たらないもの（中継の預かり期限切れなど）を送り直す
function resendLost(applied) {
  const now = Date.now();
  app.sent = app.sent.filter(s => !applied.has(s.id) && now - s.first < 3 * 86400000);
  for (const s of app.sent) {
    if (app.relay.has(s.id) || now - s.at < 30 * 60000) continue;
    s.at = now;
    publish(app.cfg.relay, app.keys.topic, s.body).catch(() => {});
  }
  ls.set(K.sent, JSON.stringify(app.sent));
}

let lastTick = 0;
async function tick(force = false) {
  if (document.hidden || !app.keys) return;
  const now = Date.now();
  if (!force && now - lastTick < 25000) return;
  lastTick = now;
  const pending = app.st && Object.values(app.st.items).some(i => i.fetch?.state === 'pending');
  if (now - app.lastSnap > (pending ? 60000 : 180000)) return refresh();
  try { await pollRelay(); recompute(); } catch { app.relayOk = false; renderBanner(); }
  if (app.outbox.length) flushOutbox();
  if (now - (ls.json(K.wx, {}).at || 0) > 3 * 3600000) loadWeather();
}

// 他の人の変更をすぐ受け取る（つながらなければ定期の確認だけで動く）
function listen() {
  try {
    app.es?.close();
    const es = new EventSource(`${app.cfg.relay}/${app.keys.topic}/sse`);
    es.addEventListener('message', async e => {
      try { if (await addRelayMessage(JSON.parse(e.data))) scheduleRecompute(); } catch { /* 無視 */ }
    });
    app.es = es;
  } catch { /* 定期の確認で補う */ }
}
let rcTimer = 0;
function scheduleRecompute() { clearTimeout(rcTimer); rcTimer = setTimeout(recompute, 150); }

function recompute() {
  if (!app.snap) return;
  const st = structuredClone(app.snap);
  const evs = [...app.relay.values()].sort((a, b) => (a.time - b.time) || ((a.at || 0) - (b.at || 0)));
  for (const ev of [...evs, ...app.outbox]) { try { L.applyEvent(st, ev); } catch { /* おかしなイベントは飛ばす */ } }
  // 中身が変わったときだけ描き直す（開いた折りたたみ・入力中のフォーカス・削除の確認を消さない）
  const sig = JSON.stringify(st);
  if (sig === app.sig) return;
  app.sig = sig; app.st = st;
  render();
}

// ---- 変更を送る ----
function send(t, payload = {}) {
  const ev = { id: uid(), t, by: app.name, at: Date.now(), ...payload };
  app.outbox.push(ev);
  saveOutbox();
  recompute();
  flushOutbox();
  return ev;
}
// 未送信の変更も、端末の中では封をして置く
let outboxSaving = Promise.resolve();
function saveOutbox() {
  const snapshot = [...app.outbox];
  outboxSaving = outboxSaving.then(async () => { try { ls.set(K.outbox, snapshot.length ? await seal(app.keys, snapshot) : ''); } catch { /* 保存できなくても送信は続ける */ } });
}
async function loadOutbox() {
  const raw = ls.get(K.outbox);
  if (!raw) return;
  try { const list = raw.startsWith('dn1.') ? await open(app.keys, raw) : JSON.parse(raw); if (Array.isArray(list)) app.outbox = [...list, ...app.outbox]; } catch { /* 読めなければ捨てる */ }
}

function shrink(ev, step) {
  const e = structuredClone(ev);
  const cut = (o, k, n) => { if (o && typeof o[k] === 'string' && o[k].length > n) o[k] = o[k].slice(0, n); };
  const n = [1500, 900, 500, 250, 100][step] ?? 50;
  cut(e.item, 'note', n); cut(e.item?.source, 'text', n); cut(e.source, 'text', n); cut(e, 'note', n);
  if (e.item?.source && step >= 3) e.item.source.thumb = '';
  if (e.source && step >= 3) e.source.thumb = '';
  return e;
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !app.outbox.length) return;
  flushing = true;
  try {
    while (app.outbox.length) {
      const ev = app.outbox[0];
      let body = await seal(app.keys, ev);
      for (let step = 0; body.length > MAX_BODY && step < 7; step++) body = await seal(app.keys, shrink(ev, step));
      if (body.length > MAX_BODY) {   // 縮めても送れないものは取り消す（後ろの変更を止めない）
        app.outbox.shift(); saveOutbox(); recompute();
        toast('長すぎて送れない変更を1件取り消しました');
        continue;
      }
      const res = await publish(app.cfg.relay, app.keys.topic, body);
      app.outbox.shift();
      ev.time = res.time;
      app.relay.set(ev.id, ev);
      app.sent.push({ id: ev.id, body, at: Date.now(), first: Date.now() });
      if (app.sent.length > 80) app.sent.splice(0, app.sent.length - 80);
      saveOutbox(); ls.set(K.sent, JSON.stringify(app.sent));
      app.relayOk = true;
    }
  } catch { app.relayOk = false; }
  finally { flushing = false; renderBanner(); }
}

async function loadWeather() {
  const city = app.st?.settings?.city || app.snap?.settings?.city || 'tokyo';
  try {
    const res = await fetch(L.weatherUrl(city));
    if (!res.ok) return;
    app.wx = L.parseWeather(await res.json());
    ls.set(K.wx, JSON.stringify({ city, at: Date.now(), data: app.wx }));
    if (app.view === 'weekend') render();
  } catch { /* 天気が無くても動く */ }
}

// ================= 画面の切り替え =================
function route() {
  const v = (location.hash.match(/^#\/(weekend|stock|done)/) || [])[1] || 'weekend';
  const changed = v !== app.view;
  app.view = v;
  if (v === 'stock') ls.set(K.seen, String(Date.now()));
  render();
  if (changed) { window.scrollTo(0, 0); $('#view').focus({ preventScroll: true }); }
}

function render() {
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.view === app.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  renderBadge();
  renderBanner();
  const view = $('#view');
  const st = app.st;
  const focusKey = document.activeElement?.closest?.('#view [data-key]')?.dataset.key;
  if (!st) {
    view.replaceChildren(app.snapOk ? loadingView() : h('section', { class: 'empty', role: 'alert' }, h('h2', {}, '読み込めませんでした'),
      h('p', {}, '電波の良い所で、もう一度お試しください。'), h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'reload' }, '読み込み直す')));
    return;
  }
  const parts = app.view === 'stock' ? viewStock(st) : app.view === 'done' ? viewDone(st) : viewWeekend(st);
  view.replaceChildren(...parts);
  if (focusKey) view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  if (app.sheet && (app.sheet.kind === 'detail' || app.sheet.kind === 'pick') && !app.sheet.draft) renderSheet();   // 入力中のシートは書き換えない
}

function renderBadge() {
  const b = $('.tabs a[data-view="stock"] .badge');
  if (!b || !app.st) return;
  const seen = Number(ls.get(K.seen) || 0);
  const n = app.view === 'stock' ? 0 : Object.values(app.st.items).filter(i => i.status === 'inbox' && i.addedAt > seen && i.addedBy !== app.name).length;
  b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n);
  b.setAttribute('aria-label', `新着${n}件`);
}

function renderBanner() {
  const el = $('#banner');
  if (!el) return;
  let msg = null, action = null;
  if (app.outbox.length && !app.relayOk) { msg = `送れていない変更が${app.outbox.length}件あります。つながったら自動で送り直します。`; action = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'retry' }, '今すぐ送る'); }
  else if (!app.snapOk && !app.snap) { msg = 'データを読み込めませんでした。電波の良い所でもう一度お試しください。'; action = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'reload' }, '読み込み直す'); }
  el.hidden = !msg;
  if (msg) el.replaceChildren(h('span', {}, msg), action);
}

function loadingView() {
  const card = () => h('li', {}, h('div', { class: 'item', 'aria-hidden': 'true' }, h('span', { class: 'thumb skeleton' }),
    h('span', { class: 'txt' }, h('span', { class: 'skeleton sk-line' }), h('span', { class: 'skeleton sk-line short' }))));
  return h('section', { 'aria-busy': 'true', 'aria-label': '読み込み中' },
    h('div', { class: 'page-head' }, h('span', { class: 'skeleton sk-line', 'aria-hidden': 'true' })),
    h('ul', { class: 'list' }, card(), card(), card()));
}

// ================= 今週末 =================
function viewWeekend(st) {
  const today = L.jstToday();
  const wk = L.weekendFor(today);
  const plan = st.plans[wk.key];
  const hol = [...new Set(Object.values(wk.holidays))];
  const head = h('div', { class: 'page-head' },
    h('h1', {}, '今週末'),
    h('p', { class: 'sub' }, h('strong', {}, L.weekendLabel(wk)), wk.days.length >= 3 ? ` · ${wk.days.length}連休` : '', hol.length ? ` · ${hol.join('・')}` : ''));
  if (!plan) return [head, emptyPlan(st, wk, today)];

  const out = [head];
  for (const d of wk.days) {
    // 過ぎた日で何も入っていない日は出さない
    if (d < today && !plan.slots.some(s => s.date === d && L.has(st.items, s.itemId))) continue;
    out.push(daySection(st, plan, d, today));
  }
  const who = plan.by === 'auto' ? `${L.mdw(L.jstToday(plan.createdAt || Date.now()))} に自動で割り振りました` : `${plan.by}さんが ${hm(plan.createdAt)} に割り振りました`;
  out.push(h('div', { class: 'plan-foot' }, h('span', {}, who),
    h('button', { class: 'btn btn-tertiary btn-sm', type: 'button', 'data-action': 'replan', 'data-key': 'replan' }, icon('refresh'), '割り振り直す')));
  return out;
}

function emptyPlan(st, wk, today) {
  const cands = L.candidates(st, wk, today);
  const autoDay = L.autoPlanDay(wk);
  const waiting = today < autoDay;
  const total = Object.values(st.items).filter(i => i.status === 'inbox').length;
  const box = h('section', { class: 'empty', 'aria-labelledby': 'empty-title' },
    h('span', { class: 'ic-wrap' }, icon('weekend')),
    h('h2', { id: 'empty-title' }, total ? (waiting ? `${L.mdw(autoDay)} の朝7時に割り振ります` : 'まもなく割り振ります') : 'まずは行きたい所をストック'),
    h('p', {}, total
      ? (cands.length ? `ストックの${cands.length}件から、天気・期限・行きたい人の数を見て、${wk.days.length}日間に入れます。待たずに決めることもできます。` : 'ストックはありますが、この週末に行けるもの（期間・定休日が合うもの）がありません。')
      : 'Instagram・Threads・X・TikTok で見つけたお店やイベントのリンクを追加すると、日付や場所を読み取ってストックします。毎週木曜の朝7時に、今週末の予定へ自動で割り振ります。'),
    cands.length
      ? h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'plan-now', 'data-key': 'plan-now' }, '今すぐ割り振る')
      : h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'add', 'data-key': 'add-empty' }, icon('plus'), 'リンクを追加'));
  const soon = cands.map(c => ({ c, end: L.lastDate(c.info) })).filter(x => x.end).sort((a, b) => a.end.localeCompare(b.end)).slice(0, 3);
  if (!soon.length) return box;
  return h('div', {}, box, h('section', { class: 'preview', 'aria-labelledby': 'soon-title' },
    h('h2', { class: 'section-title', id: 'soon-title' }, '期限が近いもの', h('small', {}, '今週末に入りやすくなります')),
    h('ul', { class: 'list' }, soon.map(x => h('li', {}, itemCard(x.c.item, today))))));
}

function weatherBadge(w) {
  const lab = L.weatherLabel(w);
  if (!lab) return null;
  return h('span', { class: 'wx' }, icon(lab.icon), h('b', {}, lab.text), `${w.max}° / ${w.min}°`, ` · 降水${w.rain}%`);
}

function daySection(st, plan, d, today) {
  const pace = st.settings.pace || 2;
  const slots = plan.slots.map((s, i) => ({ ...s, i })).filter(s => s.date === d && L.has(st.items, s.itemId))
    .sort((a, b) => L.SLOT_DEF[a.slot].order - L.SLOT_DEF[b.slot].order);
  const hol = L.holidayName(d);
  const w = app.wx[d] || plan.weather[d];
  const list = h('ol', { class: 'timeline' }, slots.map(s => slotItem(st, s, d < today)));
  const full = slots.some(s => s.slot === 'day') || slots.length >= pace;
  return h('section', { class: 'day', 'aria-labelledby': `day-${d}` },
    h('div', { class: 'day-head' },
      h('h2', { id: `day-${d}` }, `${L.DOW_JA[L.dow(d)]}曜`, h('small', {}, L.md(d))),
      hol && h('span', { class: 'holiday' }, hol),
      weatherBadge(w)),
    slots.length ? list : null,
    d >= today && !full && h('div', { class: 'slot-empty' }, h('span', {}, slots.length ? 'まだ入れられます' : 'この日は空いています'),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'pick', 'data-date': d, 'data-key': `pick-${d}` }, icon('plus'), 'ストックから選ぶ')));
}

function slotItem(st, s, past) {
  const item = st.items[s.itemId];
  const info = L.effectiveInfo(item);
  const done = item.status === 'done';
  const def = L.SLOT_DEF[s.slot];
  const meta = [info.area, L.CATEGORIES[info.category].label, info.hours].filter(Boolean);
  const actions = done
    ? [h('span', { class: 'done-pill' }, icon('done'), '行った'), h('button', { class: 'btn btn-tertiary btn-sm', type: 'button', 'data-action': 'undone', 'data-id': item.id }, '取り消す')]
    : [h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'done', 'data-id': item.id, 'data-key': `done-${s.i}` }, icon('done'), '行った'),
      !past && h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'swap', 'data-i': s.i, 'data-key': `swap-${s.i}` }, icon('swap'), '入れ替え'),
      !past && h('button', { class: 'btn btn-tertiary btn-sm', type: 'button', 'data-action': 'unslot', 'data-i': s.i, 'data-key': `unslot-${s.i}` }, '外す')];
  return h('li', { class: `tl${done ? ' is-done' : ''}` },
    h('div', { class: 'tl-time' }, h('time', {}, def.time), h('span', {}, def.label)),
    h('div', { class: 'tl-rail', 'aria-hidden': 'true' }, h('i')),
    h('div', { class: 'tl-body' }, h('article', { class: 'card plan-card' },
      h('button', { class: 'plan-main', type: 'button', 'data-action': 'open', 'data-id': item.id, 'data-key': `open-${s.i}` },
        thumb(item, info),
        h('span', { class: 'txt' },
          h('span', { class: 'plan-title' }, info.title),
          meta.length && h('span', { class: 'meta' }, meta.map(m => h('span', {}, m))),
          s.reason && h('span', { class: 'reason' }, icon('spark'), s.reason))),
      h('div', { class: 'plan-actions' }, actions))));
}

// ================= ストック =================
const FILTERS = [
  ['all', 'すべて', () => true],
  ['soon', '期限あり', i => !!L.lastDate(i)],
  ['indoor', '屋内', i => i.indoor === true],
  ['outdoor', '屋外', i => i.indoor === false],
];
function viewStock(st) {
  const today = L.jstToday();
  const items = Object.values(st.items).filter(i => i.status === 'inbox');
  const infos = new Map(items.map(i => [i.id, L.effectiveInfo(i)]));
  const f = FILTERS.find(x => x[0] === app.filter) || FILTERS[0];
  let list = items.filter(i => f[2](infos.get(i.id)));
  if (f[0] === 'soon') list.sort((a, b) => L.lastDate(infos.get(a.id)).localeCompare(L.lastDate(infos.get(b.id))));
  else list.sort((a, b) => b.addedAt - a.addedAt);
  const head = h('div', { class: 'page-head' }, h('h1', {}, 'ストック', h('span', { class: 'count' }, `${items.length}件`)),
    h('p', { class: 'sub' }, '行きたい所の置き場です。木曜の朝に、ここから今週末へ割り振ります。'));
  if (!items.length) return [head, h('section', { class: 'empty', 'aria-labelledby': 'empty-title' },
    h('span', { class: 'ic-wrap' }, icon('stock')),
    h('h2', { id: 'empty-title' }, 'まだ何もありません'),
    h('p', {}, '気になる投稿のリンクを貼るだけで、キャプションから日付・場所・営業時間などを読み取ってまとめます。'),
    h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'add', 'data-key': 'add-empty' }, icon('plus'), 'リンクを追加'),
    h('p', { class: 'hint' }, 'リンクなしで「行きたい所のメモ」だけでも追加できます。'))];
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': '絞り込み' },
    FILTERS.map(([key, label, fn]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(key === f[0]), 'data-action': 'filter', 'data-filter': key, 'data-key': `f-${key}` },
      label, h('span', { class: 'n' }, String(items.filter(i => fn(infos.get(i.id))).length)))));
  const body = list.length
    ? h('ul', { class: 'list' }, list.map(i => h('li', {}, itemCard(i, today))))
    : h('p', { class: 'help', role: 'status' }, 'この条件に合うものはありません。');
  return [head, chips, body];
}

// サムネイル。無い・期限切れのときは種類のアイコン
function thumb(item, info = L.effectiveInfo(item)) {
  const url = item.source?.thumb && safeUrl(item.source.thumb);
  const box = h('span', { class: 'thumb', 'aria-hidden': 'true' });
  const fallback = () => { box.classList.add('thumb-ic'); box.replaceChildren(icon(`c-${info.category}`)); };
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', fallback);
    box.append(img);
  } else fallback();
  return box;
}

function itemCard(item, today) {
  const info = L.effectiveInfo(item);
  const needCaption = item.platform === 'tiktok' && !item.source?.text && !item.note;   // TikTok は待っても読めない
  const waiting = item.fetch?.state === 'pending' && !item.source && !item.note && !needCaption;
  const left = L.daysUntilEnd(info, today);
  const dl = L.dateLabel(info, today);
  const meta = [info.area, info.category !== 'other' && L.CATEGORIES[info.category].label].filter(Boolean);
  return h('button', { class: 'item', type: 'button', 'data-action': 'open', 'data-id': item.id, 'data-key': `item-${item.id}` },
    thumb(item, info),
    h('span', { class: 'txt' },
      waiting
        ? [h('span', { class: 'visually-hidden' }, `${L.PLATFORM_LABEL[item.platform]}の投稿（読み込み中）`), h('span', { class: 'skeleton sk-line', 'aria-hidden': 'true' }), h('span', { class: 'skeleton sk-line', 'aria-hidden': 'true' })]
        : h('span', { class: 'item-title' }, info.title),
      !waiting && (meta.length || dl) && h('span', { class: 'meta' }, meta.map(m => h('span', {}, m)), dl && h('span', { class: left != null && left <= 7 ? 'soon' : null }, left != null && left <= 7 && left >= 0 ? `${dl}（あと${left}日）` : dl)),
      h('span', { class: 'item-foot' },
        h('span', { class: 'src' }, L.PLATFORM_LABEL[item.platform]),
        waiting && h('span', { class: 'tag-wait' }, '情報を集めています'),
        needCaption ? h('span', { class: 'tag-fail' }, 'キャプション待ち')
          : item.fetch?.state === 'failed' && !item.note && !item.source?.text && h('span', { class: 'tag-fail' }, '自動で読み取れませんでした'),
        avatars(item.by))));
}

function avatars(names = []) {
  if (!names.length) return null;
  const shown = names.slice(0, 3);
  return h('span', { class: 'avatars', 'aria-label': `${names.join('・')}が行きたい` },
    shown.map(n => h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(n))),
    names.length > 3 && h('span', { class: 'avatar', 'aria-hidden': 'true' }, `+${names.length - 3}`));
}

// ================= 行った =================
function viewDone(st) {
  const today = L.jstToday();
  const done = Object.values(st.items).filter(i => i.status === 'done').sort((a, b) => b.doneAt - a.doneAt);
  const expired = Object.values(st.items).filter(i => i.status === 'expired' || i.status === 'archived').sort((a, b) => b.updatedAt - a.updatedAt);
  const head = h('div', { class: 'page-head' }, h('h1', {}, '行った', h('span', { class: 'count' }, `${done.length}件`)));
  const out = [head];
  if (!done.length) out.push(h('section', { class: 'empty', 'aria-labelledby': 'empty-title' },
    h('span', { class: 'ic-wrap' }, icon('done')),
    h('h2', { id: 'empty-title' }, 'まだありません'),
    h('p', {}, '週末の予定で「行った」を押すと、ここに残ります。行った所は次から割り振られません。')));
  else {
    const groups = new Map();
    for (const i of done) { const d = new Date(i.doneAt); const k = `${d.getFullYear()}年${d.getMonth() + 1}月`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    for (const [k, list] of groups) out.push(h('h2', { class: 'group-title' }, k), h('ul', { class: 'list' }, list.map(i => h('li', {}, itemCard(i, today)))));
  }
  if (expired.length) out.push(h('details', { class: 'fold' }, h('summary', {}, `期限が過ぎたもの（${expired.length}件）`),
    h('ul', { class: 'list' }, expired.map(i => h('li', {}, itemCard(i, today))))));
  return out;
}

// ================= シート =================
function openSheet(kind, opts = {}) {
  if (!app.sheet) app.trigger = document.activeElement;
  app.sheet = { kind, ...opts };
  renderSheet();
  const d = $('#sheet');
  if (!d.open) d.showModal();
  (d.querySelector('[autofocus]') || d.querySelector('.sheet-head .icon-btn'))?.focus();
}
const closeSheet = () => $('#sheet').open && $('#sheet').close();

function renderSheet() {
  const s = app.sheet;
  if (!s) return;
  const d = $('#sheet');
  const parts = s.kind === 'add' ? sheetAdd(s) : s.kind === 'detail' ? sheetDetail(s) : s.kind === 'edit' ? sheetEdit(s)
    : s.kind === 'settings' ? sheetSettings() : s.kind === 'pick' ? sheetPick(s) : null;
  if (!parts) { closeSheet(); return; }
  const scroll = d.querySelector('.sheet-body')?.scrollTop || 0;
  d.replaceChildren(...parts);
  const body = d.querySelector('.sheet-body');
  if (body) body.scrollTop = scroll;
}

function sheetHead(title, kicker) {
  return h('div', { class: 'sheet-head' }, h('span', { class: 'grab', 'aria-hidden': 'true' }),
    h('h2', { id: 'sheet-title' }, kicker && h('span', { class: 'kicker' }, kicker), title),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '閉じる', 'data-action': 'close' }, icon('x')));
}

// ---- 追加 ----
function sheetAdd(s) {
  const err = h('p', { class: 'err', id: 'add-err', hidden: true });
  const url = h('textarea', { class: 'textarea', id: 'add-url', rows: '2', inputmode: 'url', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://www.instagram.com/p/…', 'aria-describedby': 'add-url-help add-err', autofocus: true });
  url.value = s.url || '';
  const ttHint = h('p', { class: 'help note', id: 'add-tt', 'aria-live': 'polite', hidden: !/tiktok\.com/i.test(url.value) },
    'TikTok は投稿の本文を自動で読めません。キャプションをコピーできたら、下のメモに一緒に貼ってください。');
  url.addEventListener('input', () => { ttHint.hidden = !/tiktok\.com/i.test(url.value); });
  const note = h('textarea', { class: 'textarea', id: 'add-note', rows: '4', 'aria-describedby': 'add-note-help' });
  note.value = s.note || '';
  const canPaste = !!navigator.clipboard?.readText;
  const form = h('form', { id: 'add-form', novalidate: true, onsubmit: e => { e.preventDefault(); submitAdd(url, note, err); } },
    h('div', { class: 'field' },
      h('label', { for: 'add-url' }, 'リンク'),
      h('div', { class: 'with-btn' }, url, canPaste && h('button', { class: 'btn btn-secondary', type: 'button', onclick: async () => {
        try { const t = await navigator.clipboard.readText(); if (t) { url.value = [url.value.trim(), t.trim()].filter(Boolean).join('\n'); url.dispatchEvent(new Event('input')); url.focus(); } }
        catch { err.hidden = false; err.textContent = '貼り付けできませんでした。入力欄を長押しして貼り付けてください。'; }
      } }, icon('paste'), '貼り付け')),
      h('p', { class: 'help', id: 'add-url-help' }, 'Instagram・Threads・X・TikTok・YouTube、お店のサイトなど。改行で区切れば、まとめて追加できます。'),
      ttHint,
      err),
    h('div', { class: 'field' },
      h('label', { for: 'add-note' }, 'メモ', h('span', { class: 'opt' }, '任意')),
      note,
      h('p', { class: 'help', id: 'add-note-help' }, 'キャプションをここに貼ると、すぐに日付や場所を読み取ります。リンクなしで、行きたい所のメモだけでも追加できます。')));
  return [sheetHead('リンクを追加'), h('div', { class: 'sheet-body' }, form),
    h('div', { class: 'sheet-foot' },
      h('button', { class: 'btn btn-tertiary', type: 'button', 'data-action': 'close' }, 'やめる'),
      h('button', { class: 'btn btn-primary', type: 'submit', form: 'add-form' }, 'ストックに追加'))];
}

function submitAdd(urlEl, noteEl, err) {
  const raw = urlEl.value.trim();
  const note = noteEl.value.trim();
  const urls = L.findUrls(raw).filter(u => u.length <= 2000 && L.parseUrl(u));
  err.hidden = true; urlEl.setAttribute('aria-invalid', 'false');
  if (raw && !urls.length) { err.hidden = false; err.textContent = 'リンクの形になっていません。https:// から始まるリンクを貼ってください。'; urlEl.setAttribute('aria-invalid', 'true'); urlEl.focus(); return; }
  if (!urls.length && !note) { err.hidden = false; err.textContent = 'リンクかメモのどちらかを入れてください。'; urlEl.setAttribute('aria-invalid', 'true'); urlEl.focus(); return; }
  const added = [];
  let dups = 0;
  if (!urls.length) {
    const id = uid(); send('item.add', { item: { id, note } }); added.push(id);
  }
  for (const u of urls) {
    const p = L.parseUrl(u);
    const dup = L.findByCanonical(app.st || { items: {} }, p.canonical);
    if (dup) { dups++; if (!dup.by.includes(app.name)) send('item.want', { itemId: dup.id }); continue; }
    const id = uid();
    send('item.add', { item: { id, url: u, note: urls.length === 1 ? note : '' } });
    added.push(id);
    fetchInBrowser({ ...p }).then(src => { if (src && (src.text || src.title)) send('item.source', { itemId: id, source: src }); });
  }
  closeSheet();
  if (location.hash !== '#/stock') location.hash = '#/stock';
  const msg = added.length ? `${added.length}件をストックに追加しました${dups ? `（${dups}件はすでにありました）` : ''}` : 'すでにストックにありました。「行きたい」を付けました';
  toast(msg, added.length ? { label: '取り消す', fn: () => added.forEach(id => send('item.delete', { itemId: id })) } : null);
}

// ---- 詳細 ----
function sheetDetail(s) {
  const st = app.st;
  const item = L.has(st?.items, s.id) ? st.items[s.id] : null;
  if (!item) return null;
  const info = L.effectiveInfo(item);
  const today = L.jstToday();
  const facts = [
    ['日程', L.dateLabel(info, today)],
    ['場所', info.place],
    ['エリア', [info.area, info.station && info.station !== info.area ? `最寄り: ${info.station}駅` : null].filter(Boolean).join(' · ')],
    ['住所', info.address],
    [info.category === 'event' || info.category === 'art' ? '時間' : '営業時間', info.hours],
    ['定休日', L.closedLabel(info)],
    ['料金', info.price],
    ['種類', L.CATEGORIES[info.category].label],
    ['屋内・屋外', info.indoor === true ? '屋内' : info.indoor === false ? '屋外' : null],
    ['かかる時間', L.DURATION_LABEL[info.duration]],
    ['注意', info.weekdayOnly ? '平日のみ（週末には入りません）' : null],
    ['メモ', item.note && clipNote(item.note)],
  ].filter(([, v]) => v);
  const url = safeUrl(item.url);
  const mine = item.by.includes(app.name);
  const tiktok = item.platform === 'tiktok';
  const noText = !item.source?.text && item.platform !== 'memo';
  const waiting = item.fetch?.state === 'pending' && item.platform !== 'memo';
  const failed = item.fetch?.state === 'failed' && noText;
  const body = h('div', { class: 'sheet-body' },
    waiting && !tiktok && h('div', { class: 'inline-alert info', role: 'status' }, '投稿の本文を取りに行っています。15分ほどで日付や場所がまとまります。待たずに、下にキャプションを貼ることもできます。'),
    noText && tiktok && (waiting || failed) && h('div', { class: 'inline-alert info', role: 'status' }, 'TikTok は投稿の本文（キャプション）を外から読めない仕組みです。TikTok で投稿を開いて説明文をコピーできたら、下に貼ってください。コピーできないときは、店名や日付など分かることを書くだけでも読み取ります。',
      url && h('div', {}, h('a', { class: 'btn btn-secondary btn-sm', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'TikTok で投稿を開く', icon('out')))),
    failed && !tiktok && h('div', { class: 'inline-alert' }, '投稿を自動で読み取れませんでした（非公開の投稿や、相手側の制限のことがあります）。キャプションを下に貼ると、日付や場所を読み取ります。',
      h('div', {}, h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'refetch', 'data-id': item.id }, icon('refresh'), 'もう一度取りに行く'))),
    noText && (waiting || failed) && captionBox(s, item),
    info.summary && h('div', { class: 'summary-box' }, h('span', { class: 'label' }, 'かんたんに言うと'), info.summary),
    facts.length && h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    url && h('a', { class: 'src-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, `${L.PLATFORM_LABEL[item.platform]}で元の投稿を開く`, icon('out')),
    item.source?.text && h('details', { class: 'raw' }, h('summary', {}, '投稿の本文'), h('p', { class: 'caption' }, item.source.text)),
    h('p', { class: 'byline' }, `${item.by.length ? `${item.by.join('・')}が行きたい` : ''}${item.addedAt ? ` · ${hm(item.addedAt)} に${item.addedBy || ''}が追加` : ''}${item.ai ? ' · Claudeが読み取り' : ''}`),
    h('div', { class: 'actions-row' },
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': mine ? 'unwant' : 'want', 'data-id': item.id }, mine ? '「行きたい」を外す' : '私も行きたい'),
      h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-action': 'delete', 'data-id': item.id }, icon('trash'), '削除')));
  const foot = item.status === 'inbox'
    ? [h('button', { class: 'btn btn-secondary', type: 'button', 'data-action': 'edit', 'data-id': item.id }, icon('edit'), '情報を直す'),
      h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'done', 'data-id': item.id }, icon('done'), '行った')]
    : [h('button', { class: 'btn btn-secondary', type: 'button', 'data-action': 'restore', 'data-id': item.id }, 'ストックに戻す'),
      h('button', { class: 'btn btn-secondary', type: 'button', 'data-action': 'edit', 'data-id': item.id }, icon('edit'), '情報を直す')];
  const kicker = [L.PLATFORM_LABEL[item.platform], item.source?.author].filter(Boolean).join(' · ');
  return [sheetHead(info.title, kicker), body, h('div', { class: 'sheet-foot' }, foot)];
}
const clipNote = s => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

// 読めなかった投稿の本文を、その場で貼ってもらう（貼った文は「投稿の本文」として読み取る）
function captionBox(s, item) {
  const err = h('p', { class: 'err', id: 'cap-err', hidden: true });
  const ta = h('textarea', { class: 'textarea', id: 'cap-text', rows: '4', maxlength: '2500', 'aria-describedby': 'cap-help cap-err',
    oninput: e => { s.draft = e.target.value; } });
  ta.value = s.draft || '';
  const canPaste = !!navigator.clipboard?.readText;
  return h('form', { class: 'caption-form', novalidate: true, onsubmit: e => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) { err.hidden = false; err.textContent = 'キャプションか、分かることを入れてください。'; ta.setAttribute('aria-invalid', 'true'); ta.focus(); return; }
    s.draft = '';
    send('item.source', { itemId: item.id, source: { author: item.source?.author || '', title: '', text, thumb: item.source?.thumb || '', via: 'paste' } });
    toast('貼った文から読み取りました');
  } },
    h('div', { class: 'field' },
      h('label', { for: 'cap-text' }, 'キャプション（投稿の説明文）'),
      ta,
      h('p', { class: 'help', id: 'cap-help' }, '日付・場所・営業時間などを読み取って、上の情報にまとめます。'),
      err),
    h('div', { class: 'actions-row' },
      canPaste && h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: async () => {
        try { const t = await navigator.clipboard.readText(); if (t) { ta.value = t.trim().slice(0, 2500); s.draft = ta.value; ta.focus(); } }
        catch { err.hidden = false; err.textContent = '貼り付けできませんでした。入力欄を長押しして貼り付けてください。'; }
      } }, icon('paste'), '貼り付け'),
      h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, '読み取る')));
}

// ---- 情報を直す ----
function sheetEdit(s) {
  const item = L.has(app.st?.items, s.id) ? app.st.items[s.id] : null;
  if (!item) return null;
  const info = L.effectiveInfo(item);
  const base = L.effectiveInfo({ ...item, edits: null });
  const r0 = (info.dates || [])[0] || {};
  const field = (id, label, input, help) => h('div', { class: 'field' }, h('label', { for: id }, label), input, help && h('p', { class: 'help' }, help));
  const txt = (id, v, attrs = {}) => h('input', { class: 'input', id, type: 'text', value: v || '', ...attrs });
  const sel = (id, opts, v) => { const el = h('select', { class: 'select', id }, opts.map(([val, lab]) => h('option', { value: val }, lab))); el.value = v; return el; };
  const fTitle = txt('e-title', info.title, { maxlength: '40', autofocus: true });
  const fArea = txt('e-area', info.area, { maxlength: '20' });
  const fPlace = txt('e-place', info.place, { maxlength: '40' });
  const fStart = h('input', { class: 'input', id: 'e-start', type: 'date', value: r0.start || '' });
  const fEnd = h('input', { class: 'input', id: 'e-end', type: 'date', value: r0.end || '' });
  const fCat = sel('e-cat', Object.entries(L.CATEGORIES).map(([k, v]) => [k, v.label]), info.category);
  const fIn = sel('e-in', [['', 'どちらでも・わからない'], ['true', '屋内'], ['false', '屋外']], info.indoor === true ? 'true' : info.indoor === false ? 'false' : '');
  const fDur = sel('e-dur', Object.entries(L.DURATION_LABEL), info.duration);
  const fTime = sel('e-time', [['any', 'いつでも'], ['morning', '午前'], ['day', '昼〜午後'], ['night', '夜']], info.timeOfDay);
  const fNote = h('textarea', { class: 'textarea', id: 'e-note', rows: '4' });
  fNote.value = item.note || '';
  const form = h('form', { id: 'edit-form', novalidate: true, onsubmit: e => {
    e.preventDefault();
    const edits = {};
    const put = (k, v, b) => { edits[k] = (v === b || v === '' || v == null) ? null : v; };
    put('title', fTitle.value.trim(), base.title); put('area', fArea.value.trim(), base.area); put('place', fPlace.value.trim(), base.place);
    put('category', fCat.value, base.category); put('duration', fDur.value, base.duration); put('timeOfDay', fTime.value, base.timeOfDay);
    const ind = fIn.value === '' ? null : fIn.value === 'true';
    edits.indoor = ind === base.indoor ? null : ind;
    const a = fStart.value || null, b = fEnd.value || null;
    const dates = a || b ? [{ start: a || null, end: b || (a && !b ? a : null) }] : [];
    const baseDates = JSON.stringify((base.dates || []).slice(0, 1));
    if (JSON.stringify(dates) !== baseDates) edits.dates = dates;
    else if (item.edits?.dates) edits.dates = null;
    const noteChanged = fNote.value.trim() !== (item.note || '');
    send('item.edit', { itemId: item.id, edits, ...(noteChanged ? { note: fNote.value.trim() } : {}) });
    openSheet('detail', { id: item.id });
    toast('情報を直しました');
  } },
  field('e-title', '名前', fTitle),
  h('div', { class: 'row2' }, field('e-area', 'エリア', fArea), field('e-place', '場所・店名', fPlace)),
  h('div', { class: 'row2' }, field('e-start', '始まり', fStart), field('e-end', '終わり', fEnd)),
  h('p', { class: 'help field-note' }, '期間のある催しだけ入れてください。1日だけなら「始まり」だけで大丈夫です。'),
  h('div', { class: 'row2' }, field('e-cat', '種類', fCat), field('e-in', '屋内・屋外', fIn)),
  h('div', { class: 'row2' }, field('e-dur', 'かかる時間', fDur), field('e-time', '向いている時間', fTime)),
  field('e-note', 'メモ', fNote, 'キャプションを貼ると、日付や場所を読み取り直します。'));
  return [sheetHead('情報を直す', info.title), h('div', { class: 'sheet-body' }, form),
    h('div', { class: 'sheet-foot' },
      h('button', { class: 'btn btn-tertiary', type: 'button', 'data-action': 'open', 'data-id': item.id }, 'やめる'),
      h('button', { class: 'btn btn-primary', type: 'submit', form: 'edit-form' }, '保存する'))];
}

// ---- ストックから選ぶ ----
function sheetPick(s) {
  const st = app.st;
  const wk = L.weekendFor(L.jstToday());
  const plan = st.plans[wk.key];
  if (!plan) return null;
  const today = L.jstToday();
  const replacing = s.index != null ? plan.slots[s.index] : null;
  const slot = replacing ? replacing.slot : null;
  const ranked = L.rankForSlot(st, plan, s.date, slot, { today });
  const body = ranked.length
    ? h('ul', { class: 'pick' }, ranked.slice(0, 30).map(c => h('li', {}, h('button', { type: 'button', 'data-action': 'choose', 'data-id': c.item.id },
      h('span', { class: 'plan-title' }, c.info.title),
      h('span', { class: 'meta' }, [c.info.area, L.CATEGORIES[c.info.category].label, L.dateLabel(c.info, today)].filter(Boolean).map(m => h('span', {}, m))),
      h('span', { class: 'reason' }, icon('spark'), c.skipped ? '今週いちど見送ったもの' : c.reason)))))
    : h('p', { class: 'help' }, replacing ? 'この時間帯に合うものがストックにありません。' : 'この日に行けるものがストックにありません。');
  return [sheetHead(`${L.mdw(s.date)}に入れる`, replacing ? '入れ替える候補' : 'ストックから選ぶ'), h('div', { class: 'sheet-body' }, body)];
}

// ---- 設定 ----
function sheetSettings() {
  const st = app.st;
  const pace = st?.settings.pace || 2;
  const city = st?.settings.city || 'tokyo';
  const nameIn = h('input', { class: 'input', id: 's-name', type: 'text', value: app.name, maxlength: '12', autocomplete: 'nickname' });
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 's-pace' },
    [[1, 'ゆったり', '1日1件'], [2, 'ふつう', '1日2件'], [3, 'たっぷり', '1日3件']].map(([v, l, sub]) =>
      h('label', {}, h('input', { type: 'radio', name: 'pace', value: String(v), checked: v === pace, onchange: () => { send('settings.set', { pace: v }); toast(`予定の量を「${l}」にしました`); } }), l, h('small', {}, sub))));
  const citySel = h('select', { class: 'select', id: 's-city', onchange: e => { send('settings.set', { city: e.target.value }); setTimeout(loadWeather, 50); } },
    Object.entries(L.CITIES).map(([k, c]) => h('option', { value: k }, c.label)));
  citySel.value = city;
  const members = Object.keys(st?.members || {});
  const status = app.outbox.length ? ['wait', `送信待ち ${app.outbox.length}件`] : app.relayOk && app.snapOk ? ['', '最新です'] : ['off', 'つながっていません'];
  return [sheetHead('設定'), h('div', { class: 'sheet-body' },
    h('section', { class: 'settings-group' }, h('h3', {}, 'あなたの名前'),
      h('div', { class: 'with-btn' }, h('label', { class: 'visually-hidden', for: 's-name' }, 'あなたの名前'), nameIn,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => {
          const v = nameIn.value.trim();
          if (!v || v === app.name) return;
          app.name = v; ls.set(K.name, v); send('member.join'); toast('名前を変えました（これからの追加に使います）');
        } }, '保存'))),
    h('section', { class: 'settings-group' }, h('h3', { id: 's-pace' }, '週末の予定の量'), seg,
      h('p', { class: 'help mt' }, '自動の割り振りで、1日に入れる数の上限です。')),
    h('section', { class: 'settings-group' }, h('h3', {}, h('label', { for: 's-city' }, '天気を見る地域')), citySel,
      h('p', { class: 'help mt' }, '雨の日は屋内、晴れの日は屋外の予定を優先します。')),
    h('section', { class: 'settings-group' }, h('h3', {}, '招待'),
      h('p', {}, '招待したい人には、あなたが受け取った招待リンクをそのまま送ってください。合言葉を知っていれば、ここで招待リンクを作り直せます。リンクを開いた人は合言葉なしで入れるので、信頼できる人にだけ送ってください。'),
      inviteForm(),
      members.length && h('div', { class: 'members', 'aria-label': 'メンバー' }, members.map(n => h('span', { class: 'member' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(n)), n)))),
    h('section', { class: 'settings-group' }, h('h3', {}, '同期'),
      h('p', { class: 'status' }, h('span', { class: `dot ${status[0]}`, 'aria-hidden': 'true' }), status[1], st?.syncedAt ? ` · 最終保存 ${hm(st.syncedAt)}` : ''),
      h('p', { class: 'mt' }, '追加や変更はすぐ他の人にも届きます。投稿の読み取りと保存は15分ごと、今週末の割り振りは毎週木曜の朝7時に自動で行います。'),
      h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'reload' }, icon('refresh'), '今すぐ更新'))),
    h('section', { class: 'settings-group' }, h('h3', {}, 'この端末'),
      h('p', {}, 'この端末から合言葉を消します。もう一度使うときは招待リンクか合言葉が必要です。'),
      h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-action': 'logout' }, 'この端末から外す'))))];
}

// 招待リンクを作る（合言葉から親鍵を作り直す。親鍵は端末に保存しない）
function inviteForm() {
  const err = h('p', { class: 'err', id: 's-pass-err', hidden: true });
  const pass = h('input', { class: 'input', id: 's-pass', type: 'password', autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false', placeholder: '合言葉', 'aria-describedby': 's-pass-err' });
  const btn = h('button', { class: 'btn btn-secondary', type: 'submit' }, icon('link'), '招待リンクを作る');
  const linkField = h('input', { class: 'input', id: 's-link', type: 'text', readonly: true, onfocus: e => e.target.select() });
  const out = h('div', { class: 'field mt', hidden: true }, h('label', { for: 's-link' }, '招待リンク'), linkField, h('p', { class: 'help' }, 'このリンクを開いた人は合言葉なしで入れます。'));
  return h('form', { class: 'mt', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    err.hidden = true; pass.setAttribute('aria-invalid', 'false');
    if (!pass.value.trim()) { err.hidden = false; err.textContent = '合言葉を入れてください'; pass.setAttribute('aria-invalid', 'true'); pass.focus(); return; }
    btn.classList.add('loading'); btn.disabled = true;
    const master = await deriveMaster(pass.value, app.cfg.salt, app.cfg.iterations);
    const keys = await keysFrom(master);
    btn.classList.remove('loading'); btn.disabled = false;
    if (keys.check !== app.cfg.check) { err.hidden = false; err.textContent = '合言葉が違います'; pass.setAttribute('aria-invalid', 'true'); pass.focus(); return; }
    pass.value = '';
    const link = `${location.origin}${location.pathname}#k=${b64u.enc(master)}`;
    out.hidden = false; linkField.value = link;
    const copy = () => navigator.clipboard?.writeText(link).then(() => toast('招待リンクをコピーしました'), () => { linkField.focus(); linkField.select(); toast('下のリンクを長押ししてコピーしてください'); });
    if (navigator.share) navigator.share({ title: '土日 DONICHI', text: '週末の予定をいっしょに決めるアプリに招待します', url: link }).catch(e => { if (e?.name !== 'AbortError') copy(); });
    else if (navigator.clipboard) copy();
    else { linkField.focus(); linkField.select(); }
  } },
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'donichi', hidden: true, readonly: true }),
  h('div', { class: 'with-btn' }, h('label', { class: 'visually-hidden', for: 's-pass' }, '合言葉'), pass, btn), err, out);
}

// ================= 操作 =================
const confirmArm = new WeakMap();
function twoStep(btn, label) {
  if (confirmArm.get(btn)) return true;
  const orig = [...btn.childNodes].map(n => n.cloneNode(true));
  btn.classList.add('confirm'); btn.textContent = label;
  confirmArm.set(btn, true);
  setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.replaceChildren(...orig); confirmArm.delete(btn); } }, 4000);
  return false;
}

function currentPlan() {
  const wk = L.weekendFor(L.jstToday());
  return { wk, plan: app.st.plans[wk.key] };
}
function setPlan(plan, msg, undoPlan) {
  send('plan.set', { plan: { ...plan, by: app.name, createdAt: Date.now() } });
  if (msg) toast(msg, undoPlan ? { label: '元に戻す', fn: () => send('plan.set', { plan: undoPlan }) } : null);
}
function weatherFor(wk, plan) {
  const out = { ...(plan?.weather || {}) };
  for (const d of wk.days) if (app.wx[d]) out[d] = app.wx[d];
  return out;
}

function onAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  const st = app.st;
  switch (a) {
    case 'close': closeSheet(); break;
    case 'add': openSheet('add'); break;
    case 'settings': openSheet('settings'); break;
    case 'open': openSheet('detail', { id }); break;
    case 'edit': openSheet('edit', { id }); break;
    case 'filter': app.filter = el.dataset.filter; ls.set(K.filter, app.filter); render(); break;
    case 'retry': flushOutbox(); break;
    case 'reload': refresh().then(() => toast('最新にしました')); break;
    case 'want': send('item.want', { itemId: id }); break;
    case 'unwant': send('item.want', { itemId: id, off: true }); break;
    case 'refetch': send('item.refetch', { itemId: id }); toast('もう一度取りに行きます（15分ほど）'); break;
    case 'done': {
      if (!L.has(st?.items, id)) break;
      send('item.status', { itemId: id, status: 'done' });
      toast('「行った」にしました', { label: '取り消す', fn: () => send('item.status', { itemId: id, status: 'inbox' }) });
      if (app.sheet?.kind === 'detail') closeSheet();
      break;
    }
    case 'undone': send('item.status', { itemId: id, status: 'inbox' }); break;
    case 'restore': send('item.status', { itemId: id, status: 'inbox' }); toast('ストックに戻しました'); break;
    case 'delete': {
      if (!twoStep(el, '本当に削除する')) break;
      const item = L.has(st.items, id) ? st.items[id] : null;
      send('item.delete', { itemId: id });
      closeSheet();
      toast('削除しました', item ? { label: '元に戻す', fn: () => send('item.add', { item: { id: uid(), url: item.url, note: item.note, source: item.source } }) } : null);
      break;
    }
    case 'plan-now': case 'replan': {
      if (a === 'replan' && !twoStep(el, '今の予定を作り直す')) break;
      const { wk, plan } = currentPlan();
      const today = L.jstToday();
      const keep = plan ? plan.slots.filter(s => L.has(st.items, s.itemId) && (s.date < today || st.items[s.itemId].status === 'done')) : [];
      const next = L.planWeekend(st, wk, { weather: weatherFor(wk, plan), today, by: app.name, keep });
      setPlan(next, next.slots.length ? `${next.slots.length}件を割り振りました` : '入れられるものがありませんでした', plan || null);
      if (!plan) setTimeout(() => window.scrollTo({ top: 0 }), 0);
      break;
    }
    case 'swap': {
      const { plan } = currentPlan();
      if (!plan) break;
      const i = Number(el.dataset.i);
      const next = L.swapSlot(st, plan, i, { today: L.jstToday() });
      if (next.slots[i].itemId) setPlan(next, '入れ替えました', plan);
      else { openSheet('pick', { date: plan.slots[i].date, index: i }); }
      break;
    }
    case 'unslot': {
      const { plan } = currentPlan();
      if (!plan) break;
      const i = Number(el.dataset.i);
      const next = structuredClone(plan);
      const [gone] = next.slots.splice(i, 1);
      if (gone?.itemId && !next.skipped.includes(gone.itemId)) next.skipped.push(gone.itemId);
      setPlan(next, '予定から外しました（ストックには残ります）', plan);
      break;
    }
    case 'pick': openSheet('pick', { date: el.dataset.date }); break;
    case 'choose': {
      const { plan } = currentPlan();
      const s = app.sheet;
      if (!plan || !s || !L.has(st.items, id)) break;
      const next = structuredClone(plan);
      const info = L.effectiveInfo(st.items[id]);
      if (s.index != null && next.slots[s.index]) {
        const old = next.slots[s.index];
        if (old.itemId && !next.skipped.includes(old.itemId)) next.skipped.push(old.itemId);
        next.slots[s.index] = { ...old, itemId: id, reason: '選んで入れた予定', slot: L.slotAfterReplace(st, next, s.index, info) };
      } else {
        const taken = next.slots.filter(x => x.date === s.date && x.itemId);
        const slot = L.freeSlotFor(info, taken, 3) || ['pm', 'am', 'night'].find(x => !taken.some(t => t.slot === x)) || 'pm';
        next.slots.push({ date: s.date, slot, itemId: id, reason: '選んで入れた予定' });
      }
      next.slots.sort((x, y) => x.date.localeCompare(y.date) || L.SLOT_DEF[x.slot].order - L.SLOT_DEF[y.slot].order);
      closeSheet();
      setPlan(next, `${L.mdw(s.date)}に入れました`, plan);
      break;
    }
    case 'logout': {
      if (!twoStep(el, '本当に外す')) break;
      for (const k of Object.values(K)) ls.del(k);
      keyStore.del('keys').then(() => location.replace(location.pathname));
      break;
    }
    default: break;
  }
}

// 共有メニュー（Android の「共有」→ 土日）から開かれたとき
function handleShare() {
  const q = new URLSearchParams(location.search);
  if (!q.has('url') && !q.has('text')) return;
  const text = [q.get('url'), q.get('text')].filter(Boolean).join('\n');
  const urls = L.findUrls(text);
  history.replaceState(null, '', `${location.pathname}#/stock`);
  route();
  openSheet('add', { url: urls.join('\n'), note: urls.length ? text.replace(/https?:\/\/\S+/g, '').trim() : text });
}

// ---- トースト ----
let toastTimer = 0;
function toast(msg, action = null) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.replaceChildren(h('span', {}, msg), ...(action ? [h('button', { type: 'button', onclick: () => { t.hidden = true; action.fn(); } }, action.label)] : []));
  t.hidden = false;
  const hide = () => { toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 3500); };
  t.onmouseenter = t.onfocusin = () => clearTimeout(toastTimer);
  t.onmouseleave = t.onfocusout = hide;
  hide();
}

boot();
