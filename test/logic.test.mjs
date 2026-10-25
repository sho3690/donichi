import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jstToday, jpHolidays, weekendFor, autoPlanDay, parseUrl, findUrls, extractDateRanges, extractInfo,
  emptyState, applyEvent, effectiveInfo, planWeekend, swapSlot, rankForSlot, maintain, eligibleOn,
  sanitizePlan, dateLabel, htmlToText,
} from '../logic.js';

const TODAY = '2026-10-26';   // 月曜

test('朝7時で日付が変わる', () => {
  assert.equal(jstToday(Date.parse('2026-10-29T06:59:00+09:00')), '2026-10-28');
  assert.equal(jstToday(Date.parse('2026-10-29T07:00:00+09:00')), '2026-10-29');
});

test('祝日（2026年）', () => {
  const h = jpHolidays(2026);
  assert.equal(h.get('2026-11-03'), '文化の日');
  assert.equal(h.get('2026-11-23'), '勤労感謝の日');
  assert.equal(h.get('2026-09-21'), '敬老の日');
  assert.equal(h.get('2026-09-22'), '国民の休日');
  assert.equal(h.get('2026-10-12'), 'スポーツの日');
});

test('今週末: 平日なら次の土日', () => {
  const wk = weekendFor(TODAY);
  assert.equal(wk.key, '2026-10-31');
  assert.deepEqual(wk.days, ['2026-10-31', '2026-11-01']);
  assert.equal(autoPlanDay(wk), '2026-10-29');
});

test('今週末: 祝日の月曜がつながると3連休', () => {
  const wk = weekendFor('2026-11-19');
  assert.deepEqual(wk.days, ['2026-11-21', '2026-11-22', '2026-11-23']);
  assert.equal(wk.holidays['2026-11-23'], '勤労感謝の日');
});

test('今週末: 日曜はその週末、ぽつんとした平日の祝日は次の土日', () => {
  assert.equal(weekendFor('2026-11-01').key, '2026-10-31');
  assert.equal(weekendFor('2026-11-03').key, '2026-11-07');
});

test('リンクの種類と正式な形', () => {
  assert.deepEqual(parseUrl('https://www.instagram.com/reel/DAbc123/?igsh=xyz'),
    { platform: 'instagram', canonical: 'https://www.instagram.com/p/DAbc123/', url: 'https://www.instagram.com/reel/DAbc123/' });
  assert.equal(parseUrl('https://www.threads.net/@cafe_tokyo/post/C9xyz?xmt=1').canonical, 'https://www.threads.com/@cafe_tokyo/post/C9xyz');
  assert.equal(parseUrl('https://twitter.com/foo/status/123456?s=20').canonical, 'https://x.com/foo/status/123456');
  assert.equal(parseUrl('https://www.tiktok.com/@abc/video/7300000000000000000?lang=ja').canonical, 'https://www.tiktok.com/@abc/video/7300000000000000000');
  assert.equal(parseUrl('https://vt.tiktok.com/ZSabc/').short, true);
  assert.equal(parseUrl('https://youtu.be/dQw4w9WgXcQ?si=1').canonical, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(parseUrl('https://example.com/a?utm_source=x&id=3').canonical, 'https://example.com/a?id=3');
  assert.equal(parseUrl('javascript:alert(1)'), null);
  assert.deepEqual(findUrls('見て https://x.com/a/status/1 と https://www.instagram.com/p/Q/。'), ['https://x.com/a/status/1', 'https://www.instagram.com/p/Q/']);
});

test('日付: 期間・曜日つき・年またぎ・終わりだけ・並び', () => {
  assert.deepEqual(extractDateRanges('日程：10/24(金)〜11/3(月・祝)', TODAY), [{ start: '2026-10-24', end: '2026-11-03' }]);
  assert.deepEqual(extractDateRanges('10月24日(金)～26日(日)開催', TODAY), [{ start: '2026-10-24', end: '2026-10-26' }]);
  assert.deepEqual(extractDateRanges('12/28〜1/5', TODAY), [{ start: '2026-12-28', end: '2027-01-05' }]);
  assert.deepEqual(extractDateRanges('〜11/3まで', TODAY), [{ start: null, end: '2026-11-03' }]);
  assert.deepEqual(extractDateRanges('11/15まで延長', TODAY), [{ start: null, end: '2026-11-15' }]);
  assert.deepEqual(extractDateRanges('11/1(土)・2(日)の2日間', TODAY), [{ start: '2026-11-01', end: '2026-11-01' }, { start: '2026-11-02', end: '2026-11-02' }]);
  assert.deepEqual(extractDateRanges('2026.12.5 OPEN', TODAY), [{ start: '2026-12-05', end: null }]);
  assert.deepEqual(extractDateRanges('11:00〜18:00 / 1/2個 / ¥1,200', TODAY), []);
});

test('読み取り: カフェの投稿', () => {
  const text = `【表参道】週末限定のモンブランパフェ🌰
「CAFE KITSUNE」

📍東京都渋谷区神宮前3-15-2
🚃表参道駅から徒歩5分
⏰11:00〜19:00
🗓定休日：水曜
💰¥1,800

#表参道カフェ #モンブラン #東京カフェ`;
  const i = extractInfo({ text }, TODAY);
  assert.equal(i.title, 'CAFE KITSUNE');
  assert.equal(i.area, '表参道');
  assert.equal(i.category, 'cafe');
  assert.equal(i.hours, '11:00〜19:00');
  assert.deepEqual(i.closedDays, [3]);
  assert.equal(i.price, '¥1,800');
  assert.deepEqual(i.dates, []);
  assert.equal(i.indoor, true);
});

test('読み取り: 期間限定のポップアップ', () => {
  const text = `＼期間限定POP UP開催／
北欧ヴィンテージ雑貨のポップアップが二子玉川で開催中！

日程：10/24(金)〜11/3(月・祝)
時間：10:00〜20:00
会場：二子玉川ライズ 1F ガレリア
入場無料`;
  const i = extractInfo({ text }, TODAY);
  assert.equal(i.category, 'event');
  assert.equal(i.area, '二子玉川');
  assert.deepEqual(i.dates, [{ start: '2026-10-24', end: '2026-11-03' }]);
  assert.equal(i.place, '二子玉川ライズ 1F ガレリア');
  assert.equal(i.price, '入場無料');
  assert.match(i.title, /北欧ヴィンテージ雑貨/);
});

test('読み取り: 訪問日は予定の日付として扱わない', () => {
  const i = extractInfo({ text: '10/20に行ってきました！中目黒の喫茶店。ナポリタンが最高でした' }, TODAY);
  assert.deepEqual(i.dates, []);
  assert.equal(i.area, '中目黒');
});

test('読み取り: 平日限定・夜の店', () => {
  assert.equal(extractInfo({ text: '平日限定ランチ 1,000円' }, TODAY).weekdayOnly, true);
  const bar = extractInfo({ text: '恵比寿の夜景が見えるルーフトップバー🍸 #恵比寿ディナー' }, TODAY);
  assert.equal(bar.category, 'bar');
  assert.equal(bar.timeOfDay, 'night');
  assert.equal(bar.area, '恵比寿');
});

test('X の埋め込みHTMLを文字にする', () => {
  assert.equal(htmlToText('<blockquote><p lang="ja">渋谷で<br>マルシェ &amp; 古着</p>&mdash; a (@a)</blockquote>'), '渋谷で\nマルシェ & 古着\n— a (@a)');
});

// ---- 状態とイベント ----
let n = 0;
const ev = (t, extra = {}) => ({ id: `e${++n}`, t, by: 'しょう', at: Date.parse('2026-10-26T12:00:00+09:00'), time: 1793000000 + n, ...extra });

function seed() {
  const st = emptyState();
  applyEvent(st, ev('item.add', { item: { id: 'A', url: 'https://www.instagram.com/p/AAA/', source: { text: '期間限定ポップアップ\n期間：10/24〜11/1\n会場：渋谷パルコ', author: 'a' } } }), { today: TODAY });
  applyEvent(st, ev('item.add', { item: { id: 'B', url: 'https://x.com/b/status/1', source: { text: '中目黒の喫茶店「珈琲ニシ」☕️ プリンが絶品', author: 'b' } } }), { today: TODAY });
  applyEvent(st, ev('item.add', { item: { id: 'C', url: 'https://www.tiktok.com/@c/video/1', source: { text: '昭和記念公園の紅葉が見頃🍁 立川駅から徒歩10分 ピクニックにも', author: 'c' } } }), { today: TODAY });
  applyEvent(st, ev('item.add', { item: { id: 'D', note: '平日限定ランチ 銀座のビストロ' } }), { today: TODAY });
  applyEvent(st, ev('item.add', { item: { id: 'E', note: '蔵前の雑貨屋 定休日：土曜' } }), { today: TODAY });
  applyEvent(st, ev('item.add', { item: { id: 'F', note: '上野の美術館 企画展 会期 9/1〜10/20' } }), { today: TODAY });
  return st;
}

test('イベント: 追加・重複・二度適用しない', () => {
  const st = emptyState();
  const e1 = ev('item.add', { item: { id: 'X1', url: 'https://www.instagram.com/p/QQ/?igsh=1' } });
  assert.equal(applyEvent(st, e1, { today: TODAY }), true);
  assert.equal(applyEvent(st, e1, { today: TODAY }), false);
  applyEvent(st, ev('item.add', { by: 'ゆう', item: { id: 'X2', url: 'https://instagram.com/reel/QQ/' } }), { today: TODAY });
  assert.equal(Object.keys(st.items).length, 1);
  assert.deepEqual(st.items.X1.by, ['しょう', 'ゆう']);
  assert.equal(st.items.X1.fetch.state, 'pending');
  assert.ok(st.members['ゆう']);
});

test('イベント: 手直しは自動の読み取りより優先', () => {
  const st = seed();
  applyEvent(st, ev('item.edit', { itemId: 'B', edits: { title: '珈琲ニシ 本店', area: '祐天寺', dates: [{ start: '2026-11-01', end: '2026-11-01' }] } }), { today: TODAY });
  const info = effectiveInfo(st.items.B);
  assert.equal(info.title, '珈琲ニシ 本店');
  assert.equal(info.area, '祐天寺');
  applyEvent(st, ev('item.edit', { itemId: 'B', edits: { area: null } }), { today: TODAY });
  assert.equal(effectiveInfo(st.items.B).area, '中目黒');
});

test('イベント: 削除すると週末の予定からも外れる', () => {
  const st = seed();
  applyEvent(st, ev('plan.set', { plan: { key: '2026-10-31', days: ['2026-10-31', '2026-11-01'], slots: [{ date: '2026-10-31', slot: 'pm', itemId: 'B', reason: 'x' }] } }));
  applyEvent(st, ev('item.delete', { itemId: 'B' }));
  assert.equal(st.items.B, undefined);
  assert.equal(st.plans['2026-10-31'].slots[0].itemId, null);
});

test('予定の検証: おかしな枠は捨てる', () => {
  const p = sanitizePlan({ key: '2026-10-31', days: ['2026-10-31', 'bad'], slots: [{ date: '2026-10-31', slot: 'pm', itemId: 'A' }, { date: '2026-11-09', slot: 'pm', itemId: 'B' }, { date: '2026-10-31', slot: 'zzz' }] });
  assert.deepEqual(p.days, ['2026-10-31']);
  assert.equal(p.slots.length, 1);
});

// ---- 割り振り ----
const WX = { '2026-10-31': { code: 63, max: 16, min: 11, rain: 80 }, '2026-11-01': { code: 1, max: 20, min: 12, rain: 10 } };

test('割り振り: 期限・平日限定・定休日・天気・期限切れを考える', () => {
  const st = seed();
  const wk = weekendFor(TODAY);
  const plan = planWeekend(st, wk, { weather: WX, today: TODAY, now: 0 });
  const where = id => plan.slots.find(s => s.itemId === id);
  assert.ok(where('A'), 'もうすぐ終わるポップアップは入る');
  assert.match(where('A').reason, /11\/1/);
  assert.equal(where('D'), undefined, '平日限定は入らない');
  assert.equal(where('F'), undefined, '期限切れは入らない');
  if (where('E')) assert.notEqual(where('E').date, '2026-10-31', '土曜定休は土曜に入らない');
  assert.ok(where('C'), '紅葉は入る');
  assert.equal(where('C').date, '2026-11-01', '外の予定は晴れの日曜へ');
  for (const d of wk.days) assert.ok(plan.slots.filter(s => s.date === d).length <= 2, '1日2件まで');
  assert.equal(eligibleOn(effectiveInfo(st.items.E), '2026-10-31'), false);
});

test('割り振り: 予定の量（ゆったり＝1日1件）', () => {
  const st = seed();
  st.settings.pace = 1;
  const plan = planWeekend(st, weekendFor(TODAY), { weather: WX, today: TODAY });
  assert.ok(plan.slots.length <= 2);
});

test('入れ替え: 別の候補が入り、元のものは見送りに', () => {
  const st = seed();
  st.settings.pace = 1;
  const plan = planWeekend(st, weekendFor(TODAY), { weather: WX, today: TODAY });
  const before = plan.slots[0].itemId;
  const next = swapSlot(st, plan, 0, { today: TODAY });
  assert.notEqual(next.slots[0].itemId, before);
  assert.ok(next.skipped.includes(before));
  const ranked = rankForSlot(st, next, next.slots[0].date, next.slots[0].slot, { today: TODAY });
  assert.ok(ranked.every(c => c.item.id !== next.slots[0].itemId));
});

test('片づけ: 期限切れと「前回見送り」', () => {
  const st = seed();
  const plan = planWeekend(st, weekendFor(TODAY), { weather: WX, today: TODAY });
  st.plans[plan.key] = sanitizePlan(plan);
  const planned = plan.slots[0].itemId;
  assert.equal(maintain(st, '2026-11-02'), true);
  assert.equal(st.items.F.status, 'expired');
  assert.equal(st.items[planned].postponed, 1);
  assert.equal(st.plans[plan.key].closed, true);
  assert.equal(maintain(st, '2026-11-02'), false, '二度目は何もしない');
});

test('日付の表示', () => {
  assert.equal(dateLabel({ dates: [{ start: '2026-10-24', end: '2026-11-03' }] }, TODAY), '10/24〜11/3');
  assert.equal(dateLabel({ dates: [{ start: '2026-11-01', end: '2026-11-01' }] }, TODAY), '11/1(日)のみ');
  assert.equal(dateLabel({ dates: [{ start: null, end: '2026-11-03' }] }, TODAY), '〜11/3');
});

test('日付の誤検出を避ける（レビューの指摘）', () => {
  const T = '2026-10-26';
  assert.deepEqual(extractInfo({ text: '中目黒のカフェ 味 4/5 雰囲気 5/5 営業時間11:00〜18:00' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: 'ケーキ 1/2サイズもあり 期間限定 11:00〜18:00' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: '年末も営業！12/31は休みです。限定メニューあり' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: '【2024.12.1 リニューアル】イベント開催中のカフェ' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: '期間：10/24〜11/3 開催' }, T).dates, [{ start: '2026-10-24', end: '2026-11-03' }]);
});

test('メモを直すと Claude の読み取りをやり直す・期限切れから戻すと期限を外す', () => {
  const st = emptyState();
  applyEvent(st, { id: 'z1', t: 'item.add', by: 'a', at: Date.parse('2026-10-26T12:00:00+09:00'), item: { id: 'M', note: 'メモ' } });
  st.items.M.ai = { dates: [] }; st.items.M.aiTries = 1;
  applyEvent(st, { id: 'z2', t: 'item.edit', by: 'a', itemId: 'M', note: '期間：11/1〜11/3 開催' }, { today: '2026-10-26' });
  assert.equal(st.items.M.ai, null);
  assert.deepEqual(effectiveInfo(st.items.M).dates, [{ start: '2026-11-01', end: '2026-11-03' }]);
  st.items.M.status = 'expired';
  applyEvent(st, { id: 'z3', t: 'item.status', by: 'a', itemId: 'M', status: 'inbox' }, { today: '2026-11-10' });
  assert.equal(maintain(st, '2026-11-10'), false);
  assert.equal(st.items.M.status, 'inbox');
});

test('入れ替えの候補は枠の時間帯に合うものだけ', () => {
  const st = emptyState();
  const add = (id, note) => applyEvent(st, { id: `a-${id}`, t: 'item.add', by: 'a', at: 0, item: { id, note } }, { today: TODAY });
  add('BAR', '恵比寿の夜景バー ディナー');
  add('ART', '上野の美術館 企画展');
  add('TRIP', '箱根へ日帰り旅行 温泉');
  const plan = { key: '2026-10-31', days: ['2026-10-31', '2026-11-01'], slots: [], weather: {}, skipped: [] };
  const am = rankForSlot(st, plan, '2026-10-31', 'am', { today: TODAY }).map(c => c.item.id);
  assert.ok(am.includes('ART') && !am.includes('BAR') && !am.includes('TRIP'));
  const night = rankForSlot(st, plan, '2026-10-31', 'night', { today: TODAY }).map(c => c.item.id);
  assert.deepEqual(night, ['BAR']);
});

test('日付の誤検出（2回目の指摘）', () => {
  const T = '2026-10-26';
  assert.deepEqual(extractInfo({ text: '年末年始 12/29〜1/3 は休業します。イベント開催中のカフェ' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: '12/31・1/1は休み。マルシェ出店あり' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: '待ち時間は1/3ほど短縮。イベント開催' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: '数量限定のパフェ 10/20' }, T).dates, []);
  assert.deepEqual(extractInfo({ text: '期間：10/24〜11/3 開催（月曜休み）' }, T).dates, [{ start: '2026-10-24', end: '2026-11-03' }]);
  assert.deepEqual(extractInfo({ text: 'マルシェ開催 11/8(日)' }, T).dates, [{ start: '2026-11-08', end: '2026-11-08' }]);
});

test('「1日」枠の入れ替えは何でも入り、時間帯が変わる', () => {
  const st = emptyState();
  const add = (id, note) => applyEvent(st, { id: `b-${id}`, t: 'item.add', by: 'a', at: 0, item: { id, note } }, { today: TODAY });
  add('TRIP', '箱根へ日帰り旅行 温泉');
  add('CAFE', '中目黒の喫茶店 プリン');
  const plan = { key: '2026-10-31', days: ['2026-10-31', '2026-11-01'], slots: [{ date: '2026-10-31', slot: 'day', itemId: 'TRIP', reason: '' }], weather: {}, skipped: [] };
  const next = swapSlot(st, plan, 0, { today: TODAY });
  assert.equal(next.slots[0].itemId, 'CAFE');
  assert.equal(next.slots[0].slot, 'pm');
});
