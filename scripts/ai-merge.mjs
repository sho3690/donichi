// Claude の読み取り結果を検証して保存する（データの鍵があるジョブ）。結果が無くても試した回数は数える。
import { sanitizeInfo, has } from '../logic.js';
import { keysFrom, open, b64u } from '../crypto.js';
import { loadKeys, loadState, saveState } from './state-io.mjs';

const hand = await keysFrom(b64u.dec(String(process.env.AI_KEY || '').trim()));
const input = process.env.AI_IN ? await open(hand, process.env.AI_IN) : { posts: [] };
let out = {};
try { if (process.env.AI_OUT) out = await open(hand, process.env.AI_OUT); } catch { /* 読み取りのジョブが失敗した */ }
const { keys } = await loadKeys();
const state = await loadState(keys);
let n = 0;
for (const { id } of input.posts || []) {
  if (!has(state.items, id)) continue;
  const item = state.items[id];
  item.aiTries = (item.aiTries || 0) + 1;
  if (has(out, id) && out[id] && typeof out[id] === 'object') { item.ai = sanitizeInfo(out[id]); n++; }
}
if ((input.posts || []).length) { await saveState(keys, state); console.log(`Claude の結果: ${n}件を反映`); }
