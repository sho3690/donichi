// Claude の読み取り結果を検証して保存する（データの鍵がある手順）。結果が無くても試した回数は数える。
import { readFile } from 'node:fs/promises';
import { sanitizeInfo, has } from '../logic.js';
import { loadKeys, loadState, saveState, tmpPath } from './state-io.mjs';

const input = JSON.parse(await readFile(tmpPath('ai-in'), 'utf8').catch(() => '{"posts":[]}'));
const out = JSON.parse(await readFile(tmpPath('ai-out'), 'utf8').catch(() => '{}'));
const { keys } = await loadKeys();
const state = await loadState(keys);
let n = 0;
for (const { id } of input.posts) {
  if (!has(state.items, id)) continue;
  const item = state.items[id];
  item.aiTries = (item.aiTries || 0) + 1;
  if (has(out, id) && out[id] && typeof out[id] === 'object') { item.ai = sanitizeInfo(out[id]); n++; }
}
if (input.posts.length) { await saveState(keys, state); console.log(`Claude の結果: ${n}件を反映`); }
