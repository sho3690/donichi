// GitHub Actions から15分ごとに実行する。
// 1) 中継に届いた追加・変更を取り込む 2) 投稿の本文を取って情報を読み取る 3) 片づけ
// 4) 木曜の朝7時を過ぎたら今週末を自動で割り振る 5) 暗号化して data/state.json に保存
// 6) Claude で読み取るものがあれば、本文だけを受け渡し用の鍵（AI_KEY）で封をして次のジョブへ渡す
//    （Claude はデータの鍵も書き込み権限も無い別のジョブ・別のマシンで動く）
// 公開リポジトリのログは誰でも読めるので、件数以外（題名・URL・名前・エラー文）は出力しない。

import { appendFile } from 'node:fs/promises';
import { poll } from '../relay.js';
import { open, seal, keysFrom, b64u } from '../crypto.js';
import {
  applyEvent, jstToday, weekendFor, autoPlanDay, planWeekend, maintain, refreshAuto,
  parseWeather, weatherUrl, sanitizePlan, sanitizeSource, candidates, clip,
} from '../logic.js';
import { fetchOnServer } from './sources-server.mjs';
import { loadKeys, loadState, saveState } from './state-io.mjs';

const log = [];
const say = s => { log.push(s); console.log(s); };

async function main() {
  const { cfg, keys } = await loadKeys();
  const state = await loadState(keys);
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
    try {
      const ev = await open(keys, m.message);
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { broken++; continue; }
      ev.time = m.time;
      if (applyEvent(state, ev, { today: jstToday(Number(ev.at) || m.time * 1000) })) applied++;
    } catch { broken++; }   // おかしなイベント1件で同期全体を止めない
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
      item.fetch = { state: tries >= 4 ? 'failed' : 'pending', tries, nextAt: now + 15 * 60000 * 2 ** tries, error: String(e?.message || e).slice(0, 80) };
      missed++;
    }
  }
  if (due.length) say(`本文: ${due.length}件を取得 → 成功${got}件・失敗${missed}件`);

  // 3) 片づけ
  if (maintain(state, today)) say('片づけ: 期限切れ・終わった週末を整理');

  // 4) 木曜の朝7時を過ぎたら、今週末を割り振る（候補が無ければ、入るまで待つ）
  const wk = weekendFor(today);
  if (!state.plans[wk.key] && today >= autoPlanDay(wk) && candidates(state, wk, today).length) {
    let weather = {};
    try {
      const res = await fetch(weatherUrl(state.settings.city));
      if (res.ok) weather = parseWeather(await res.json());
    } catch { say('天気予報を取れませんでした（天気なしで割り振ります）'); }
    const plan = sanitizePlan(planWeekend(state, wk, { weather, today, now, by: 'auto' }));
    state.plans[wk.key] = plan;
    say(`割り振り: ${wk.key} の週末に ${plan.slots.length}件`);
  }

  // 5) 保存
  if (JSON.stringify(state) !== before) {
    state.syncedAt = now;
    await saveState(keys, state);
    say('保存しました');
  } else say('変更なし');

  // 6) Claude に読み取ってもらうもの（鍵が登録されているときだけ）
  let needAi = 0, aiIn = '';
  if (process.env.HAS_AI === 'true' && process.env.AI_KEY) {
    const need = Object.values(state.items)
      .filter(i => i.status === 'inbox' && !i.ai && (i.aiTries || 0) < 2 && (i.fetch?.state === 'ok' || i.fetch?.state === 'failed') && (i.source?.text || i.source?.title || i.note))
      .slice(0, 6)
      .map(i => ({ id: i.id, platform: i.platform, author: i.source?.author || '', text: clip([i.source?.title, i.source?.text].filter(Boolean).join('\n'), 1800), memo: clip(i.note || '', 600) }));
    if (need.length) aiIn = await seal(await keysFrom(b64u.dec(process.env.AI_KEY.trim())), { today, posts: need });
    needAi = need.length;
    if (needAi) say(`Claude で読み取るもの: ${needAi}件`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `need_ai=${needAi}\nai_in=${aiIn}\n`);
}

try { await main(); }
catch (e) { say(`同期に失敗しました: ${e?.name || 'Error'}`); process.exitCode = 1; }   // エラー文には中身が混ざりうるので種類だけ
finally { if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, log.map(l => `- ${l}`).join('\n') + '\n'); }
