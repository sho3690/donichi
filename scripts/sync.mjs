// GitHub Actions から15分ごとに実行する。
// 1) 中継に届いた追加・変更を取り込む 2) 投稿の本文を取って情報を読み取る 3) 片づけ
// 4) 木曜の朝7時を過ぎたら今週末を自動で割り振る 5) 暗号化して data/state.json に保存
// 公開リポジトリのログは誰でも読めるので、件数以外（題名・URL・名前）は絶対に出力しない。

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { keysFrom, seal, open, b64u } from '../crypto.js';
import { poll } from '../relay.js';
import {
  emptyState, applyEvent, jstToday, weekendFor, autoPlanDay, planWeekend, maintain, refreshAuto,
  parseWeather, weatherUrl, sanitizePlan, sanitizeSource, candidates,
} from '../logic.js';
import { fetchOnServer } from './sources-server.mjs';
import { aiExtract, hasClaude } from './ai.mjs';

const ROOT = new URL('..', import.meta.url);
const log = [];
const say = s => { log.push(s); console.log(s); };
const fail = s => { console.log(`::error::${s}`); process.exit(1); };

const KEY = process.env.DONICHI_KEY;
if (!KEY) fail('DONICHI_KEY が Secrets にありません');
const cfg = JSON.parse(await readFile(new URL('config.json', ROOT), 'utf8'));
const keys = await keysFrom(b64u.dec(KEY.trim()));
if (keys.check !== cfg.check) fail('DONICHI_KEY が config.json の合言葉と合いません');

const stateUrl = new URL('data/state.json', ROOT);
const file = JSON.parse(await readFile(stateUrl, 'utf8').catch(() => '{}'));
const state = file.sealed ? await open(keys, file.sealed) : emptyState();
const before = JSON.stringify(state);
const now = Number(process.env.DONICHI_NOW) || Date.now();   // 試運転用に時刻を差し替えられる
const today = jstToday(now);

// 1) 中継のイベント
let applied = 0, broken = 0, msgs = [];
try {
  const since = state.log.lastTime ? Math.max(0, state.log.lastTime - 900) : 'all';
  msgs = await poll(cfg.relay, keys.topic, since);
} catch (e) { say(`中継に届きませんでした（次の回で取り込みます）: ${e.name}`); }
for (const m of msgs) {
  let ev;
  try { ev = await open(keys, m.message); } catch { broken++; continue; }
  ev.time = m.time;
  try { if (applyEvent(state, ev, { today: jstToday(Number(ev.at) || m.time * 1000) })) applied++; }
  catch { broken++; }   // おかしなイベント1件で同期全体を止めない
}
say(`中継: ${msgs.length}件を確認、${applied}件を反映${broken ? `、読めないもの${broken}件` : ''}`);

// 2) 投稿の本文
const due = Object.values(state.items).filter(i => i.fetch?.state === 'pending' && (i.fetch.nextAt || 0) <= now).slice(0, 15);
let got = 0, missed = 0;
for (const item of due) {
  try {
    const src = sanitizeSource(await fetchOnServer(item));
    if (!src || !(src.text || src.title)) throw new Error('本文が見つかりません');
    item.source = src;
    item.fetch = { state: 'ok', tries: (item.fetch.tries || 0) + 1, nextAt: 0, error: '' };
    item.ai = null; item.aiTries = 0;
    refreshAuto(item, today);
    got++;
  } catch (e) {
    const tries = (item.fetch.tries || 0) + 1;
    item.fetch = { state: tries >= 4 ? 'failed' : 'pending', tries, nextAt: now + 15 * 60000 * 2 ** tries, error: String(e.message || e).slice(0, 80) };
    missed++;
  }
}
if (due.length) say(`本文: ${due.length}件を取得 → 成功${got}件・失敗${missed}件`);

// 3) Claude で読み取り（鍵があるときだけ）
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  const need = Object.values(state.items)
    .filter(i => i.status === 'inbox' && !i.ai && (i.aiTries || 0) < 2 && (i.fetch?.state === 'ok' || i.fetch?.state === 'failed') && (i.source?.text || i.source?.title || i.note))
    .slice(0, 8);
  if (need.length) {
    try {
      if (!hasClaude()) execFileSync('npm', ['install', '-g', '@anthropic-ai/claude-code'], { stdio: 'ignore', timeout: 180000 });
      const res = aiExtract(need, today);
      for (const i of need) { i.aiTries = (i.aiTries || 0) + 1; if (res[i.id]) i.ai = res[i.id]; }
      say(`Claude: ${need.length}件を読み取り、${Object.keys(res).length}件に反映`);
    } catch (e) {
      for (const i of need) i.aiTries = (i.aiTries || 0) + 1;
      // エラー文には投稿の本文（プロンプト）が含まれうるので、ログには終了コードだけ出す
      say(`Claude の読み取りに失敗（ルールでの読み取りのまま）: 終了コード ${e.status ?? '-'}`);
    }
  }
}

// 4) 片づけ
if (maintain(state, today)) say('片づけ: 期限切れ・終わった週末を整理');

// 5) 木曜の朝7時を過ぎたら、今週末を割り振る
const wk = weekendFor(today);
if (!state.plans[wk.key] && today >= autoPlanDay(wk) && candidates(state, wk, today).length) {   // 候補が無ければ、入るまで待つ
  let weather = {};
  try {
    const res = await fetch(weatherUrl(state.settings.city));
    if (res.ok) weather = parseWeather(await res.json());
  } catch { say('天気予報を取れませんでした（天気なしで割り振ります）'); }
  const plan = sanitizePlan(planWeekend(state, wk, { weather, today, now, by: 'auto' }));
  state.plans[wk.key] = plan;
  say(`割り振り: ${wk.key} の週末に ${plan.slots.length}件`);
}

// 保存
if (JSON.stringify(state) !== before) {
  state.syncedAt = now;
  await writeFile(stateUrl, JSON.stringify({ v: 1, sealed: await seal(keys, state) }) + '\n');
  say('保存しました');
} else say('変更なし');

if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, log.map(l => `- ${l}`).join('\n') + '\n');
