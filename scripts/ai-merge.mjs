// Claude の読み取り結果と、検索で調べた住所を検証して保存する（データの鍵があるジョブ）。
// 結果が無くても試した回数は数える（読み取りのジョブが失敗し続けても、同じものを何度も頼まない）。
import { sanitizeInfo, sanitizeLookup, has } from '../logic.js';
import { keysFrom, open, b64u } from '../crypto.js';
import { loadKeys, loadState, saveState } from './state-io.mjs';

const hand = await keysFrom(b64u.dec(String(process.env.AI_KEY || '').trim()));
const input = process.env.AI_IN ? await open(hand, process.env.AI_IN) : { posts: [], finds: [] };
let out = null;
try { if (process.env.AI_OUT) out = await open(hand, process.env.AI_OUT); } catch { /* 読み取りのジョブが失敗した */ }
const posts = (input.posts || []).map(p => p.id), finds = (input.finds || []).map(f => f.id);
const read = out?.read || {}, found = out?.found || {};
const tried = out ? (Array.isArray(out.tried) ? out.tried : []) : posts;
const looked = out ? (Array.isArray(out.looked) ? out.looked : []) : finds;
const { keys } = await loadKeys();
const state = await loadState(keys);
let n = 0, m = 0;
for (const id of tried) {
  if (!posts.includes(id) || !has(state.items, id)) continue;
  const item = state.items[id];
  item.aiTries = (item.aiTries || 0) + 1;
  if (has(read, id) && read[id] && typeof read[id] === 'object') { item.ai = sanitizeInfo(read[id]); n++; }
}
for (const id of looked) {
  if ((!posts.includes(id) && !finds.includes(id)) || !has(state.items, id)) continue;
  const item = state.items[id];
  item.lookupTries = (item.lookupTries || 0) + 1;
  const f = has(found, id) ? sanitizeLookup(found[id]) : null;
  if (f) { item.lookup = f; if (f.address) m++; }
}
if (tried.length || looked.length) { await saveState(keys, state); console.log(`Claude の結果: 読み取り${n}件・住所${m}件を反映`); }
