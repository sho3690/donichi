import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyEvent, planWeekend, weekendFor, maintain, effectiveInfo, candidates } from '../logic.js';

// 他の人から届くイベントは信用しない。どんな形でも例外を出さず、状態を壊さないこと。
const junk = [null, undefined, 0, '', 'x', [], {}, { id: 1 }, { id: 'a' }, { id: 'b', t: 'item.add' }, { id: 'c', t: 'item.add', item: null },
  { id: 'd', t: 'item.add', item: { id: 5, url: 'https://x.com/a/status/1' } }, { id: 'e', t: 'item.add', item: { id: 'i1', url: 'javascript:alert(1)' } },
  { id: 'f', t: 'item.add', item: { id: 'i2', url: 12345 } }, { id: 'g', t: 'item.add', item: { id: 'i3', note: { a: 1 } } },
  { id: 'h', t: 'item.edit', itemId: 'nope', edits: { dates: 'x' } }, { id: 'i', t: 'plan.set', plan: { key: '2026-13-45', days: 'x' } },
  { id: 'j', t: 'plan.set', plan: { key: '2026-10-31', days: ['2026-10-31'], slots: [null, 1, { date: '2026-10-31', slot: 'constructor' }], weather: 'x', skipped: [1, 'a'] } },
  { id: 'k', t: 'settings.set', pace: 99, city: '__proto__' }, { id: 'l', t: 'member.join', by: { toString: 1 } }, { id: 'm', t: 'item.status', itemId: '__proto__', status: 'done' },
  { id: 'n', t: 'item.source', itemId: 'i9', source: 'x' }, { id: 'o', t: '__proto__' }, { id: 'p', t: 'item.add', by: 'x'.repeat(10000), item: { id: 'big', note: 'あ'.repeat(100000) } },
  { id: 'q', t: 'item.add', item: { id: 'ok', url: 'https://www.instagram.com/p/AAA/', source: { text: 'a', thumb: 'javascript:alert(1)' } } },
  { id: 'r', t: 'item.edit', itemId: 'ok', edits: { category: 'nope', indoor: 'yes', closedDays: [1, 'x', 9, -1], dates: [{ start: 'bad', end: '2026-11-01' }, null, 5] } },
];

test('壊れたイベントでも例外を出さない', () => {
  const st = emptyState();
  for (const ev of junk) assert.doesNotThrow(() => applyEvent(st, ev, { today: '2026-10-26' }), JSON.stringify(ev)?.slice(0, 80));
  assert.equal(Object.getPrototypeOf(st.items), Object.prototype);
  assert.equal(st.settings.pace, 2);
  assert.equal(st.settings.city, 'tokyo');
  assert.equal(st.items.i1, undefined, 'javascript: のリンクは入らない');
  assert.equal(st.items.ok.source.thumb, '', '危ない画像URLは捨てる');
  const info = effectiveInfo(st.items.ok);
  assert.equal(info.category, 'other');
  assert.deepEqual(info.closedDays, [1]);
  assert.deepEqual(info.dates, [{ start: null, end: '2026-11-01' }]);
  assert.ok(st.items.big.note.length <= 3000);
  assert.ok([...Object.keys(st.members)].every(n => n.length <= 24));
  assert.equal({}.polluted, undefined);
  assert.doesNotThrow(() => { const wk = weekendFor('2026-10-26'); planWeekend(st, wk, { today: '2026-10-26' }); candidates(st, wk, '2026-10-26'); maintain(st, '2026-11-02'); });
});
