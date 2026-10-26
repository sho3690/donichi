// 土日 DONICHI — 計算部分。画面にも通信にも触らない純粋関数だけを置く（test/ で検証）。
// ブラウザと GitHub Actions(Node) の両方から読み込む。日付はすべて 'YYYY-MM-DD'（日本時間）で扱う。

export const DAY_START_HOUR = 7;            // 日替わりは朝7時（夜更かしで0時過ぎにも見るため）
const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, '0');

// ---- 日付 ----
export const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseYmd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
export const addDays = (s, n) => ymd(new Date(parseYmd(s).getTime() + n * DAY_MS));
export const dow = s => parseYmd(s).getUTCDay();
export const diffDays = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / DAY_MS);   // b − a
export const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
export const md = s => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
export const mdw = s => `${md(s)}(${DOW_JA[dow(s)]})`;
const validYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
// 他の人から届く値で辞書を引くときは、必ず自前のキーだけを見る（__proto__ などを踏まない）
export const has = (o, k) => typeof k === 'string' && o != null && Object.hasOwn(o, k);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export const safeId = k => typeof k === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k) && !RESERVED.has(k);
const safeName = v => { const n = typeof v === 'string' ? v.trim().slice(0, 24) : ''; return n && !RESERVED.has(n) ? n : ''; };

// 朝7時区切りの「今日」（日本時間）
export function jstToday(now = Date.now()) {
  return ymd(new Date(now + (9 - DAY_START_HOUR) * 3600000));
}

// ---- 祝日（内閣府の規則を計算で再現。春分・秋分は近似式） ----
function nthMonday(y, m, n) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((8 - first) % 7) + (n - 1) * 7; }
function equinox(y, base) { return Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); }

const holidayCache = new Map();
export function jpHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const h = new Map();
  const set = (m, d, name) => h.set(`${year}-${pad(m)}-${pad(d)}`, name);
  set(1, 1, '元日'); set(1, nthMonday(year, 1, 2), '成人の日'); set(2, 11, '建国記念の日'); set(2, 23, '天皇誕生日');
  set(3, equinox(year, 20.8431), '春分の日'); set(4, 29, '昭和の日');
  set(5, 3, '憲法記念日'); set(5, 4, 'みどりの日'); set(5, 5, 'こどもの日');
  set(7, nthMonday(year, 7, 3), '海の日'); set(8, 11, '山の日');
  set(9, nthMonday(year, 9, 3), '敬老の日'); set(9, equinox(year, 23.2488), '秋分の日');
  set(10, nthMonday(year, 10, 2), 'スポーツの日'); set(11, 3, '文化の日'); set(11, 23, '勤労感謝の日');
  for (const key of [...h.keys()]) {                 // 振替休日: 日曜の祝日は次の平日へ
    if (dow(key) !== 0) continue;
    let x = addDays(key, 1);
    while (h.has(x)) x = addDays(x, 1);
    h.set(x, '振替休日');
  }
  for (let s = `${year}-01-02`; s < `${year}-12-31`; s = addDays(s, 1)) {   // 国民の休日: 祝日に挟まれた平日
    if (h.has(s) || dow(s) === 0) continue;
    if (h.has(addDays(s, -1)) && h.has(addDays(s, 1))) h.set(s, '国民の休日');
  }
  holidayCache.set(year, h);
  return h;
}
export const holidayName = s => jpHolidays(+s.slice(0, 4)).get(s) || null;
export function isOffDay(s) {
  const w = dow(s);
  if (w === 0 || w === 6) return true;
  const m = +s.slice(5, 7), d = +s.slice(8, 10);
  if ((m === 12 && d >= 29) || (m === 1 && d <= 3)) return true;   // 年末年始
  return !!holidayName(s);
}

// ---- 週末（土日＋つながった祝日） ----
// 今日が土日を含む休みの中ならその休み、そうでなければ次の土曜を含む休み。key はその休みの最初の土曜。
const MAX_WEEKEND_DAYS = 9;
function offBlock(day) {
  let start = day;
  while (isOffDay(addDays(start, -1)) && diffDays(addDays(start, -1), day) < MAX_WEEKEND_DAYS) start = addDays(start, -1);
  const days = [];
  for (let s = start; isOffDay(s) && days.length < MAX_WEEKEND_DAYS; s = addDays(s, 1)) days.push(s);
  return days;
}
export function weekendFor(today) {
  let days = null;
  if (isOffDay(today)) {
    const b = offBlock(today);
    if (b.some(s => dow(s) === 6 || dow(s) === 0)) days = b;
  }
  if (!days) {
    let sat = addDays(today, 1);
    while (dow(sat) !== 6) sat = addDays(sat, 1);
    days = offBlock(sat);
  }
  const key = days.find(s => dow(s) === 6) || days[0];
  const holidays = {};
  for (const s of days) { const n = holidayName(s); if (n) holidays[s] = n; }
  return { key, days, holidays };
}
// 自動で割り振る日（木曜の朝7時。休みが木曜以前に始まるなら、その前日）
export function autoPlanDay(wk) {
  const thu = addDays(wk.key, -2);
  const before = addDays(wk.days[0], -1);
  return before < thu ? before : thu;
}

// ---- 文字の整形 ----
const codePoint = c => (Number.isInteger(c) && c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : '');
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, x) => codePoint(parseInt(x, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => codePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…').replace(/&amp;/g, '&');
}
export function htmlToText(html) {
  return decodeEntities(String(html ?? '').slice(0, 60000)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]{0,2000}>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
export const stripEmoji = s => String(s).replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
export function clip(s, n) { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---- リンク ----
export const PLATFORM_LABEL = { instagram: 'Instagram', threads: 'Threads', x: 'X', tiktok: 'TikTok', youtube: 'YouTube', web: 'Web', memo: 'メモ' };

export function findUrls(text) {
  return [...new Set((String(text).match(/https?:\/\/[^\s<>"'「」（）()、。]+/g) || []).map(u => u.replace(/[.,!?)\]]+$/, '')))];
}

// 共有されたリンクを種類ごとの正式な形にそろえる（重複判定と取得に使う）
export function parseUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  let m;
  if (host === 'instagram.com' || host === 'instagr.am') {
    const i = parts.findIndex(p => ['p', 'reel', 'reels', 'tv'].includes(p));
    if (i >= 0 && parts[i + 1]) return { platform: 'instagram', canonical: `https://www.instagram.com/p/${parts[i + 1]}/`, url: `https://www.instagram.com/${parts[i] === 'reels' ? 'reel' : parts[i]}/${parts[i + 1]}/` };
    return { platform: 'instagram', canonical: `https://www.instagram.com/${parts.join('/')}${parts.length ? '/' : ''}`, url: u.origin + u.pathname };
  }
  if (host === 'threads.net' || host === 'threads.com') {
    if (parts[0]?.startsWith('@') && parts[1] === 'post' && parts[2]) {
      const c = `https://www.threads.com/${parts[0]}/post/${parts[2]}`;
      return { platform: 'threads', canonical: c, url: c };
    }
    return { platform: 'threads', canonical: `https://www.threads.com/${parts.join('/')}`, url: u.href };
  }
  if (['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com'].includes(host)) {
    const i = parts.indexOf('status');
    if (i >= 1 && /^\d+$/.test(parts[i + 1] || '')) {
      const c = `https://x.com/${parts[i - 1]}/status/${parts[i + 1]}`;
      return { platform: 'x', canonical: c, url: c };
    }
    return { platform: 'x', canonical: `https://x.com/${parts.join('/')}`, url: u.href };
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    if ((m = u.pathname.match(/\/(@[^/]+)\/(video|photo)\/(\d+)/))) {
      const c = `https://www.tiktok.com/${m[1]}/${m[2]}/${m[3]}`;
      return { platform: 'tiktok', canonical: c, url: c };
    }
    return { platform: 'tiktok', canonical: `https://${u.hostname}${u.pathname.replace(/\/$/, '')}`, url: u.origin + u.pathname, short: true };
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    const id = host === 'youtu.be' ? parts[0] : (u.searchParams.get('v') || (['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : null));
    if (id) return { platform: 'youtube', canonical: `https://www.youtube.com/watch?v=${id}`, url: parts[0] === 'shorts' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}` };
  }
  // その他のサイト: 追跡用のパラメータだけ落とす
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|igsh|igshid|si$|s$|t$|ref)/.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return { platform: 'web', canonical: u.href, url: u.href };
}

// ---- 投稿の文章から情報を読み取る（ルールで推定。Claude が使えるときは上書きされる） ----
export const CATEGORIES = {
  cafe:     { label: 'カフェ・甘味',   indoor: true,  duration: 'short', time: 'day' },
  food:     { label: 'ごはん',         indoor: true,  duration: 'short', time: 'any' },
  bar:      { label: '夜・お酒',       indoor: true,  duration: 'short', time: 'night' },
  art:      { label: '展示・アート',   indoor: true,  duration: 'short', time: 'day' },
  event:    { label: 'イベント',       indoor: null,  duration: 'half',  time: 'day' },
  nature:   { label: '自然・さんぽ',   indoor: false, duration: 'half',  time: 'day' },
  shop:     { label: 'お買い物',       indoor: true,  duration: 'short', time: 'day' },
  activity: { label: '体験・あそび',   indoor: true,  duration: 'half',  time: 'any' },
  trip:     { label: '遠出',           indoor: null,  duration: 'full',  time: 'day' },
  other:    { label: 'その他',         indoor: null,  duration: 'short', time: 'any' },
};
export const DURATION_LABEL = { short: '1〜2時間', half: '半日', full: '1日' };

const CAT_WORDS = {
  cafe: ['カフェ', '喫茶', 'コーヒー', '珈琲', 'cafe', 'coffee', 'スイーツ', 'パフェ', 'ケーキ', 'タルト', 'ドーナツ', 'ベーカリー', 'パン屋', 'かき氷', 'プリン', 'モーニング', '抹茶', 'ジェラート', 'アイス', 'クレープ', 'チーズケーキ', 'スコーン', '甘味', 'あんみつ', 'ティー'],
  food: ['ランチ', 'ディナー', 'ごはん', 'ご飯', 'グルメ', 'レストラン', '焼肉', 'ラーメン', '寿司', '鮨', 'イタリアン', 'フレンチ', '中華', '定食', '食べ放題', 'ビストロ', '和食', 'カレー', 'バーガー', 'ピザ', '焼き鳥', '焼鳥', 'そば', '蕎麦', 'うどん', '天ぷら', 'とんかつ', 'もんじゃ', 'お好み焼き', '餃子', 'ステーキ', 'コース', '海鮮', '丼', 'おにぎり', '食堂', '飯'],
  bar: ['バー', 'bar', 'ワイン', 'ビール', 'クラフトビール', '日本酒', 'カクテル', 'ナイト', '夜景', 'はしご酒', '居酒屋', '立ち飲み', '酒場', 'ルーフトップ'],
  art: ['展示', '展覧会', '個展', '企画展', '美術館', 'ギャラリー', '博物館', 'ミュージアム', 'エキシビション', 'exhibition', 'アート', '写真展', 'museum', 'gallery', '没入'],
  event: ['イベント', 'フェス', 'マルシェ', '祭り', 'まつり', 'ポップアップ', 'pop up', 'popup', 'pop-up', '開催', 'フリマ', 'ライブ', '花火', '蚤の市', 'ワークショップ', '期間限定', 'コラボ', '初出店', 'ハロウィン', 'クリスマスマーケット', 'イルミネーション', 'ライトアップ', '縁日', '朝市', '会期'],
  nature: ['公園', '紅葉', '桜', '花畑', 'ハイキング', '登山', '散歩', 'さんぽ', '海', 'ビーチ', 'キャンプ', '庭園', '自然', '絶景', 'ピクニック', '植物園', '湖', '滝', '高原', '牧場', 'ネモフィラ', 'コスモス', 'ひまわり', 'あじさい', '梅', 'いちょう', '銀杏'],
  shop: ['雑貨', 'ショップ', '古着', '本屋', '書店', 'セレクトショップ', '買い物', 'ショッピング', '器', '文具', '文房具', 'アンティーク', 'インテリア', '花屋', 'ヴィンテージ', 'vintage', 'store', 'shop'],
  activity: ['体験', 'サウナ', '温泉', '銭湯', 'スパ', '映画', '水族館', '動物園', 'ボウリング', '陶芸', '遊園地', 'プラネタリウム', '謎解き', 'ボルダリング', 'カラオケ', 'ゲーム', 'テーマパーク', 'スケート', '釣り', 'ヨガ'],
  trip: ['日帰り', '旅行', '遠出', 'ドライブ', '一泊', '1泊', '温泉街', '観光', '小旅行', '旅', 'trip'],
};

// エリア名（長いものから先に照合する）
const AREA_LIST = ('渋谷,新宿,原宿,表参道,青山,外苑前,銀座,有楽町,丸の内,東京駅,日本橋,人形町,神田,神保町,御茶ノ水,秋葉原,上野,浅草,蔵前,押上,両国,錦糸町,清澄白河,門前仲町,月島,豊洲,お台場,池袋,目白,高田馬場,早稲田,神楽坂,飯田橋,四ツ谷,赤坂,六本木,麻布十番,麻布台,虎ノ門,新橋,浜松町,品川,五反田,目黒,中目黒,恵比寿,代官山,広尾,白金,自由が丘,二子玉川,三軒茶屋,下北沢,代々木上原,代々木,初台,学芸大学,祐天寺,駒沢,用賀,中野,高円寺,阿佐ヶ谷,荻窪,西荻窪,吉祥寺,三鷹,国分寺,立川,八王子,高尾,町田,調布,府中,谷中,根津,千駄木,日暮里,北千住,赤羽,十条,巣鴨,大塚,吉祥寺,柴又,葛西,舞浜,横浜,みなとみらい,桜木町,関内,元町,中華街,鎌倉,北鎌倉,江ノ島,江の島,藤沢,湘南,葉山,逗子,茅ヶ崎,箱根,小田原,熱海,伊豆,川崎,武蔵小杉,溝の口,大宮,浦和,川越,所沢,秩父,千葉,船橋,柏,幕張,木更津,成田,日光,軽井沢,京都,嵐山,祇園,河原町,大阪,梅田,難波,なんば,心斎橋,天王寺,中崎町,神戸,三宮,元町,名古屋,栄,福岡,天神,博多,札幌,仙台,金沢,奈良,広島,那覇,沖縄,北海道')
  .split(',').filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b.length - a.length);
export const KNOWN_AREAS = AREA_LIST;

const PREF = '(?:東京都|北海道|京都府|大阪府|[\\u4e00-\\u9fff]{2,3}県)';
const RAIL_PREFIX = /^(?:JR|東京メトロ|メトロ|都営(?:地下鉄)?|地下鉄|京王|小田急|東急|西武|東武|京急|京成|相鉄|りんかい線|阪急|阪神|近鉄|南海|名鉄|各線|線)/;
const WD = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

function normalizeText(s) {
  return String(s ?? '').normalize('NFKC').replace(/[〜～∼]/g, '~').replace(/[‐‑‒–—―ー](?=\s*\d)/g, m => (m === 'ー' ? m : '-'));
}

// 年が書かれていない日付は「今日に近い方」の年にする（過去120日〜未来240日）
function inferYear(mo, d, today) {
  const y = +today.slice(0, 4);
  for (const yy of [y, y + 1, y - 1]) {
    const s = `${yy}-${pad(mo)}-${pad(d)}`;
    if (!validYmd(s)) continue;
    const diff = diffDays(today, s);
    if (diff >= -120 && diff <= 240) return s;
  }
  return null;
}

// 文章中の日付と期間を拾う。返り値: [{start, end}]（start/end は null 可＝その側が開いている）
export function extractDates(text, today) {
  const t = normalizeText(text);
  const toks = [];
  const take = (re, fn) => { for (const m of t.matchAll(re)) { if (toks.some(k => m.index < k.end && m.index + m[0].length > k.start)) continue; const s = fn(m); if (s) toks.push({ start: m.index, end: m.index + m[0].length, ymd: s }); } };
  take(/(20\d{2})\s*[/.\-年]\s*(\d{1,2})\s*[/.\-月]\s*(\d{1,2})\s*日?/g, m => { const s = `${m[1]}-${pad(m[2])}-${pad(m[3])}`; return validYmd(s) ? s : null; });
  take(/(?<![\d/.\-])(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})(?:\s*日)?(?![\d:/%]|\s*(?:[時分人円個名点杯本枚皿倍程]|サイズ|カット|ホール|人前|切れ|ほど|くらい|ぐらい))/g, m => (+m[1] >= 1 && +m[1] <= 12 ? inferYear(+m[1], +m[2], today) : null));
  toks.sort((a, b) => a.start - b.start);
  const WEEKDAY_PAREN = /^\s*(?:[(（][^)）]{0,6}[)）])?/;
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const a = toks[i];
    const after = t.slice(a.end).replace(WEEKDAY_PAREN, '');
    const before = t.slice(Math.max(0, a.start - 3), a.start);
    if (/(味|評価|星|★|☆|点数|満足度|コスパ|雰囲気|接客|サービス|おすすめ度|リピ度|総合|映え度|混雑度)\s*[:：]?\s*$/.test(t.slice(Math.max(0, a.start - 8), a.start)) || /^\s*点/.test(after)) continue;   // 評価「味 4/5」
    // 「12/31は休み」「12/31・1/1は休み」「12/29〜1/3は休業」は行ける日ではない
    const CLOSED = /^(?:\s*(?:[・,、&]|~|-)\s*(?:\d{1,2}\s*[/月]\s*)?\d{1,2}\s*日?(?:\s*[(（][^)）]{0,6}[)）])?)*\s*(?:は|が|も)?\s*(?:休み|お休み|休業|定休|休館|休店|close|CLOSE)/;
    if (CLOSED.test(after)) { while (toks[i + 1] && /^[\s・,、&~\-日()（）月火水木金土祝]*$/.test(t.slice(a.end, toks[i + 1].start))) i++; continue; }
    const sep = after.match(/^\s*(?:~|-|から|より)\s*/);
    if (sep) {
      const rest = after.slice(sep[0].length);
      const b = toks[i + 1];
      const gap = b ? t.slice(a.end, b.start).replace(WEEKDAY_PAREN, '') : null;
      if (b && /^\s*(?:~|-|から|より)\s*$/.test(gap)) {        // 10/24 ~ 11/3
        let end = b.ymd;
        if (end < a.ymd) end = `${+end.slice(0, 4) + 1}${end.slice(4)}`;
        out.push({ start: a.ymd, end, pos: a.start }); i++; continue;
      }
      const dOnly = rest.match(/^(\d{1,2})\s*日?(?![\d/月:])/);       // 10/24 ~ 26
      if (dOnly) {
        let end = `${a.ymd.slice(0, 8)}${pad(dOnly[1])}`;
        if (!validYmd(end)) { out.push({ start: a.ymd, end: a.ymd, pos: a.start }); continue; }
        if (end < a.ymd) end = addDays(`${a.ymd.slice(0, 8)}01`, 32).slice(0, 8) + pad(dOnly[1]);
        if (validYmd(end)) { out.push({ start: a.ymd, end, pos: a.start }); continue; }
      }
      out.push({ start: a.ymd, end: null, pos: a.start }); continue;    // 11/1 ~（開始のみ）
    }
    if (/[~-]\s*$/.test(before) || /^\s*まで/.test(after)) { out.push({ start: null, end: a.ymd, pos: a.start }); continue; }   // ~11/3, 11/3まで
    if (/^\s*(?:オープン|OPEN|open|グランドオープン|NEW OPEN|開業|リニューアル|から|より|以降)/.test(after)) { out.push({ start: a.ymd, end: null, pos: a.start }); continue; }
    out.push({ start: a.ymd, end: a.ymd, pos: a.start });
    let more = after;                                                    // 11/1(土)・2(日)
    for (let m; (m = more.match(/^\s*[・,、&]\s*(\d{1,2})\s*日?(?![\d/月:])\s*(?:[(（][^)）]{0,6}[)）])?/)); more = more.slice(m[0].length)) {
      const s2 = `${a.ymd.slice(0, 8)}${pad(m[1])}`;
      if (validYmd(s2) && s2 > a.ymd) out.push({ start: s2, end: s2, pos: a.start });
    }
  }
  // 重複を除き、30日より前に終わったもの（昔の告知・リニューアル日など）は捨てる
  return out.filter((r, i) => out.findIndex(o => o.start === r.start && o.end === r.end) === i)
    .filter(r => diffDays(r.end || r.start, today) <= 30);
}
// pos を落とした形（保存・表示用）
export function extractDateRanges(text, today) {
  return extractDates(text, today).map(({ start, end }) => ({ start, end }));
}

function scoreCategories(text) {
  const low = text.toLowerCase();
  const score = {};
  for (const [cat, words] of Object.entries(CAT_WORDS)) {
    let n = 0;
    for (const w of words) {
      const re = new RegExp(w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      n += (low.match(re) || []).length;
    }
    if (n) score[cat] = n;
  }
  return score;
}

function pickArea(sources) {
  for (const src of sources) {
    if (!src) continue;
    for (const a of AREA_LIST) if (src.includes(a)) return a === '東京駅' ? '東京駅' : a.replace(/^江の島$/, '江ノ島');
  }
  return null;
}

const SENTENCE_END = /(でした|です|ます|ました|だった|よね|よ|ね|な|た|!|！|\?|？|♡|w)$/;

export function extractInfo({ text = '', title = '', author = '', note = '', platform = '' } = {}, today) {
  const raw = [note, text].filter(Boolean).join('\n');
  const body = normalizeText(raw);
  const lines = body.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const tags = [...new Set((body.match(/#[^\s#、。]+/g) || []).map(x => x.slice(1)))].slice(0, 12);
  const cleanLine = l => stripEmoji(l.replace(/#[^\s#]+/g, '').replace(/@[\w.]+/g, ''))
    .replace(/【[^】]{1,12}】/g, ' ').replace(/[＼\\／/★☆✧✦◆◇■□●○▶▷♪♡❤︎]+/g, ' ').replace(/^[\s・\-*>|:]+/, '').replace(/\s{2,}/g, ' ').trim();

  // 場所（📍 の行・「店名：」などのラベル）
  let placeLine = null;
  for (const l of String(raw).normalize('NFKC').split(/\n+/)) {
    if (/^\s*(?:📍|📌|🏠|🏢|🗺|📮|🏪|🏬|⛳|🏯|🏛)/u.test(l)) { placeLine = cleanLine(l); if (placeLine) break; }
  }
  const labelOf = re => { const m = body.match(re); return m ? cleanLine(m[1]) || null : null; };
  const nameLab = labelOf(/(?:店名|店舗名|施設名|お店|shop|name)\s*[:：]\s*([^\n]{2,50})/i);
  const venueLab = labelOf(/(?:場所|会場|開催場所|開催地|スポット|place|venue)\s*[:：]\s*([^\n]{2,50})/i);
  const labeled = nameLab || venueLab;
  const addrM = body.match(new RegExp(`(?:〒?\\d{3}-\\d{4}\\s*)?(${PREF}[^\\s、。「」#()（）]{2,40})`));
  const address = addrM ? addrM[1] : null;
  const isAddressish = s => !!s && (new RegExp(`^${PREF}`).test(s) || /\d+-\d+|丁目|番地/.test(s));

  // 最寄り駅
  const stations = [];
  for (const m of body.matchAll(/([\u4e00-\u9fffァ-ヶーぁ-んA-Za-z]{1,12})駅/g)) {
    let name = m[1].replace(RAIL_PREFIX, '');
    const known = AREA_LIST.find(a => name.endsWith(a));
    if (known) name = known; else name = name.replace(/^[ぁ-ん]+/, '');
    if (name && !/^(最寄り?|各|同|前|次|隣|主要|線)$/.test(name) && name.length <= 7) stations.push(name);
  }

  // エリア: 📍の行 → 住所 → 駅 → タグ → 本文
  let area = pickArea([isAddressish(placeLine) ? null : placeLine, labeled, stations.join(' '), tags.join(' '), lines.slice(0, 3).join(' '), address, body]);
  if (!area && stations[0]) area = stations[0];
  if (!area && address) {
    const w = address.match(new RegExp(`^${PREF}([^\\d\\s]{1,6}?[区市町村])`));
    if (w) area = w[1].replace(/(区|市)$/, '') || w[1];
  }

  // 種類（名前の選び方にも使う）
  const sc = scoreCategories(`${body}\n${tags.join(' ')}\n${normalizeText(title)}`);
  const order = ['event', 'art', 'trip', 'bar', 'cafe', 'food', 'nature', 'activity', 'shop'];
  let category = 'other', best = 0;
  for (const c of order) if ((sc[c] || 0) > best) { best = sc[c]; category = c; }
  if (category === 'event' && sc.art >= sc.event) category = 'art';

  // 名前（タイトル）。イベントや展示は会場より催しの名前を優先する
  let name = null;
  const head = lines.slice(0, 5).join('\n');
  const br = [...head.matchAll(/[「『]([^」』\n]{2,24})[」』]/g)].map(m => stripEmoji(m[1]).trim()).find(s => s && !SENTENCE_END.test(s) && !KNOWN_AREAS.includes(s) && !/^(PR|pr|保存|保存推奨|保存版|お知らせ|告知)$/.test(s));
  const cut = v => v.split(/[(（|｜/／,、]|\s{2,}/)[0].trim() || null;
  const firstLine = () => {
    const f = lines.map(cleanLine).find(l => l.length >= 3 && !/^(PR|pr)$/.test(l) && !isAddressish(l) && !/^(日程|日時|期間|会期|時間|営業時間|会場|場所|住所|料金)/.test(l));
    return f ? f.split(/[。!！?？]/)[0].trim() || null : null;
  };
  if (br) name = br;
  if (!name && nameLab && !isAddressish(nameLab)) name = cut(nameLab);
  if (!name && (category === 'event' || category === 'art')) name = firstLine();
  if (!name && placeLine && !isAddressish(placeLine)) name = cut(placeLine);
  if (!name && venueLab && !isAddressish(venueLab)) name = cut(venueLab);
  if (!name) name = firstLine();
  if (!name && title) name = cleanLine(normalizeText(title));
  if (!name) name = author ? `${author}の投稿` : platform && platform !== 'memo' ? `${PLATFORM_LABEL[platform] || ''}の投稿` : 'メモ';
  name = clip(name, 32);

  // 日付（イベントらしい文脈のときだけ信用する。訪問日などは捨てる）
  // 営業時間の「11:00〜18:00」の「〜」で催し扱いにしない
  const noTimes = body.replace(/\d{1,2}[:時]\d{0,2}\s*[~\-]\s*\d{1,2}[:時]\d{0,2}/g, ' ');
  // 単発の日付を信じるのは、はっきり催しとわかる言葉があるときだけ（「数量限定」「販売」などでは信じない）
  const eventish = /(開催|会期|日時|日程|イベント|展示|展覧会|個展|企画展|写真展|フェス|マルシェ|ポップアップ|pop ?up|祭り?|ライブ|花火|出店|蚤の市|フリマ)/i.test(noTimes);
  const bodyN = normalizeText(body);
  let dates = extractDates(body, today).filter(r => {
    const ctx = bodyN.slice(Math.max(0, r.pos - 12), r.pos + 18);
    return !/(訪問|行ってき|行った|撮影|投稿|visited|来店|食べてき|オープンしました)/.test(ctx);
  }).map(({ start, end }) => ({ start, end }));
  if (!eventish) dates = dates.filter(r => r.start !== r.end);   // 単発の日付は文脈が無ければ信用しない
  dates = dates.slice(0, 6);

  // 営業時間・定休日・料金
  const hm = body.match(/(\d{1,2})[:時](\d{2})?\s*[~\-]\s*(\d{1,2})[:時](\d{2})?/);
  const hours = hm ? `${hm[1]}:${hm[2] || '00'}〜${hm[3]}:${hm[4] || '00'}` : null;
  let closedDays = null;
  const cm = body.match(/(?:定休日?|休業日|店休日|お休み|closed?|CLOSED?)\s*[:：]?\s*([^\n\s]{1,16})/i);
  if (cm) {
    if (/(なし|無休|年中無休|不定休)/.test(cm[1])) closedDays = [];
    else {
      const ds = [...cm[1].replace(/祝日?|毎週|第\d/g, '').matchAll(/([月火水木金土日])(?:曜日?)?/g)].map(m => WD[m[1]]);
      if (ds.length) closedDays = [...new Set(ds)].sort();
    }
  }
  if (/年中無休|無休/.test(body) && !closedDays) closedDays = [];
  const weekdayOnly = /平日(のみ|限定|だけ)/.test(body) && !/土日/.test(body);
  const pm = body.match(/(?:[¥]\s?\d[\d,]*|\d[\d,]*\s?円)(?:\s*~\s*(?:[¥]\s?)?\d[\d,]*円?)?|入場無料|参加無料|入場料無料|観覧無料/);
  const price = pm ? pm[0].replace(/\s/g, '') : null;

  const def = CATEGORIES[category];
  let indoor = def.indoor;
  if (/(屋外|野外|テラス|ピクニック|紅葉|花火|ビーチ|キャンプ|登山|ハイキング|公園|庭園|マルシェ|朝市|フリマ|蚤の市)/.test(body) && category !== 'cafe' && category !== 'food') indoor = false;
  if (/(屋内|室内|館内|雨の日でも|雨でも)/.test(body)) indoor = true;
  let duration = def.duration;
  if (/(日帰り|一日中|1日中|遠出|ドライブ|小旅行)/.test(body)) duration = 'full';
  let timeOfDay = def.time;
  if (/(ディナー|夜景|ナイト|バー|居酒屋|ライトアップ|イルミネーション|飲み|夜ごはん|夜ご飯|はしご酒)/.test(body)) timeOfDay = 'night';
  else if (/(モーニング|朝活|朝ごはん|朝ご飯|朝食|早朝|朝市)/.test(body)) timeOfDay = 'morning';
  else if (/ランチ/.test(body) && category === 'food') timeOfDay = 'day';

  // ひとこと（名前とは別の、まとまった最初の文。無ければ読み取った情報から組み立てる）
  const sentence = lines.slice(0, 8).map(cleanLine).filter(l => l && l.length >= 12 && !name.startsWith(l.slice(0, 10)) && !isAddressish(l)
    && !/^(営業時間|定休日|住所|アクセス|料金|価格|TEL|電話|予約|日程|日時|期間|会期|時間|会場|場所)/.test(l))[0] || '';
  let summary = clip(sentence.split(/(?<=[。!！])/)[0], 70);
  if (!summary && (area || category !== 'other')) {
    const dl = dateLabel({ dates }, today || jstToday());
    summary = `${area ? `${area}の` : ''}${CATEGORIES[category].label}${dl ? `（${dl}）` : ''}${price && /無料/.test(price) ? '。入場無料' : ''}`;
  }

  const found = [area, dates.length, hours, price, category !== 'other', placeLine || labeled].filter(Boolean).length;
  return {
    title: name, place: (placeLine && !isAddressish(placeLine) ? clip(placeLine, 40) : labeled ? clip(labeled, 40) : null),
    area, address: address ? clip(address, 60) : null, station: stations[0] || null,
    dates, hours, closedDays, weekdayOnly, price, category, indoor, duration, timeOfDay,
    summary, tags, confidence: found >= 3 ? 'high' : found >= 1 ? 'mid' : 'low',
  };
}

// AI（Claude）や手直しで上書きされた情報を合わせる。手直しが最優先。
export function effectiveInfo(item) {
  const out = { ...(item.auto || {}) };
  for (const src of [item.ai, item.edits]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && k !== 'dates' && k !== 'closedDays' && !v.length)) out[k] = v;
  }
  if (item.edits && Array.isArray(item.edits.dates)) out.dates = item.edits.dates;
  // 投稿に住所が無ければ、施設を検索して見つけた住所で補う（手で直したものが最優先）
  if (!out.address && item.lookup?.address) out.address = item.lookup.address;
  if (!out.area && item.lookup?.area) out.area = item.lookup.area;
  out.title = out.title || 'メモ';
  out.category = has(CATEGORIES, out.category) ? out.category : 'other';
  const q = geoKey(out);   // 位置はサーバーが住所などから割り出す。住所が変わったら次の同期で割り出し直す
  if (q && item.geo?.q === q && Number.isFinite(item.geo.lat) && Number.isFinite(item.geo.lng)) out.geo = { lat: item.geo.lat, lng: item.geo.lng };
  return out;
}

// 位置を割り出す手がかり（住所 → 施設名 → エリア）。サーバーはこれが変わったときだけ割り出し直す
export function geoKey(info) {
  return info.address ? `a:${info.address}` : info.place ? `p:${info.place}` : info.area ? `r:${info.area}` : '';
}
// 写真を探す名前（施設名 → 題名 → エリア）。「〇〇の投稿」「メモ」のような仮の題名は使わない
export function imageQueries(info) {
  const t = info.title && !/の投稿$|^メモ$/.test(info.title) && info.title.length >= 2 ? info.title : '';
  const head = x => (x ? String(x).trim().split(/[\s\u3000(（・/]/)[0] : '');   // 「表参道ヒルズ 大階段前」→「表参道ヒルズ」
  const ph = head(info.place);
  return [...new Set([info.place, ph.length >= 2 ? ph : '', t, info.area].filter(Boolean).map(x => String(x).trim()).filter(Boolean))].slice(0, 4);
}
export function distKm(a, b) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
// 住所を検索で調べる名前（施設名。無ければ種類が分かっているものの題名）
export function lookupName(info) {
  if (info.place) return String(info.place).slice(0, 60);
  const t = info.title && !/の投稿$|^メモ$/.test(info.title) ? String(info.title) : '';
  return t && info.category !== 'other' ? t.slice(0, 60) : '';
}
// 検索で調べた住所。都道府県から始まらないものは使わない
export function sanitizeLookup(f) {
  if (!f || typeof f !== 'object' || typeof f.q !== 'string') return null;
  const address = typeof f.address === 'string' && new RegExp(`^${PREF}`).test(f.address.trim()) ? f.address.trim().slice(0, 80) : null;
  const area = typeof f.area === 'string' && f.area.trim() ? f.area.trim().replace(/駅$/, '').slice(0, 20) : null;
  return { q: f.q.slice(0, 60), address, area: address ? area : null };
}
export const kmLabel = d => (d < 1 ? `約${Math.max(100, Math.round(d * 10) * 100)}m` : `約${d < 10 ? d.toFixed(1) : Math.round(d)}km`);

// ---- 状態とイベント ----
// 状態は「スナップショット（Actions が保存）」＋「中継に届いたイベント」を順に適用して作る。
export function emptyState() {
  return { v: 1, items: {}, plans: {}, settings: { pace: 2, city: 'tokyo' }, members: {}, log: { lastTime: 0, applied: [] }, updatedAt: 0 };
}
const MAX_APPLIED = 1500;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const ITEM_STATUSES = ['inbox', 'done', 'expired', 'archived'];

export function sanitizeSource(s) {
  if (!s || typeof s !== 'object') return null;
  const thumb = str(s.thumb, 2000);
  return { author: str(s.author, 80), text: str(s.text, 2500), title: str(s.title, 200), thumb: /^https:\/\//.test(thumb) ? thumb : '', via: str(s.via, 30) };
}
function sanitizeDates(a) {
  if (!Array.isArray(a)) return undefined;
  return a.slice(0, 6).map(r => ({ start: validYmd(r?.start) ? r.start : null, end: validYmd(r?.end) ? r.end : null })).filter(r => r.start || r.end);
}
export function sanitizeInfo(e) {
  if (!e || typeof e !== 'object') return {};
  const out = {};
  for (const k of ['title', 'place', 'area', 'address', 'hours', 'price', 'summary', 'station']) if (k in e) out[k] = e[k] === null ? null : str(e[k], k === 'summary' ? 140 : 80);
  if ('dates' in e) out.dates = e.dates === null ? null : sanitizeDates(e.dates) || [];
  if ('category' in e && has(CATEGORIES, e.category)) out.category = e.category;
  if ('indoor' in e) out.indoor = e.indoor === true || e.indoor === false ? e.indoor : null;
  if ('duration' in e && has(DURATION_LABEL, e.duration)) out.duration = e.duration;
  if ('timeOfDay' in e && ['morning', 'day', 'night', 'any'].includes(e.timeOfDay)) out.timeOfDay = e.timeOfDay;
  if ('closedDays' in e) out.closedDays = Array.isArray(e.closedDays) ? [...new Set(e.closedDays.filter(n => Number.isInteger(n) && n >= 0 && n <= 6))] : null;
  if ('weekdayOnly' in e) out.weekdayOnly = !!e.weekdayOnly;
  return out;
}

export function newItem({ id, url, note, source, by, at }, today) {
  const p = url ? parseUrl(url) : null;
  const item = {
    id, url: p ? p.url : '', canonical: p ? p.canonical : '', platform: p ? p.platform : 'memo',
    note: str(note, 3000), by: by ? [by] : [], addedBy: by || '', addedAt: at, status: 'inbox', doneAt: 0, postponed: 0,
    source: sanitizeSource(source), fetch: { state: 'pending', tries: 0, nextAt: 0, error: '' },
    auto: null, ai: null, edits: null, updatedAt: at,
  };
  if (item.platform === 'memo' || item.source) item.fetch.state = 'ok';
  refreshAuto(item, today);
  return item;
}
export function refreshAuto(item, today) {
  const s = item.source || {};
  item.auto = extractInfo({ text: s.text || '', title: s.title || '', author: s.author || '', note: item.note, platform: item.platform }, today);
  return item;
}

export function findByCanonical(state, canonical) {
  if (!canonical) return null;
  return Object.values(state.items).find(i => i.canonical === canonical) || null;
}

// イベントを1つ適用する（state を書き換える）。同じ id は二度適用しない。
export function applyEvent(state, ev, { today } = {}) {
  if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string') return false;
  if (state.log.applied.includes(ev.id)) return false;
  today = today || jstToday(ev.at || Date.now());
  const by = safeName(ev.by);
  const at = Number(ev.at) || Date.now();
  const it = safeId(ev.itemId) && has(state.items, ev.itemId) ? state.items[ev.itemId] : null;
  switch (ev.t) {
    case 'item.add': {
      const x = ev.item || {};
      if (!safeId(x.id) || has(state.items, x.id)) break;
      const p = x.url ? parseUrl(x.url) : null;
      if (x.url && !p) break;
      const dup = p ? findByCanonical(state, p.canonical) : null;
      if (dup) { if (by && !dup.by.includes(by)) dup.by.push(by); if (x.note && !dup.note) dup.note = str(x.note, 3000); if (dup.status !== 'inbox' && dup.status !== 'done') dup.status = 'inbox'; dup.updatedAt = at; refreshAuto(dup, today); break; }
      if (!p && !str(x.note, 3000).trim()) break;
      state.items[x.id] = newItem({ id: x.id, url: x.url, note: x.note, source: x.source, by, at }, today);
      break;
    }
    case 'item.edit': {
      if (!it) break;
      const e = sanitizeInfo(ev.edits);
      it.edits = { ...(it.edits || {}) };
      for (const [k, v] of Object.entries(e)) { if (v === null || (k !== 'dates' && k !== 'closedDays' && v === '')) delete it.edits[k]; else it.edits[k] = v; }
      if (typeof ev.note === 'string' && str(ev.note, 3000) !== it.note) { it.note = str(ev.note, 3000); it.ai = null; it.aiTries = 0; refreshAuto(it, today); }
      it.updatedAt = at;
      break;
    }
    case 'item.status': {
      if (!it || !ITEM_STATUSES.includes(ev.status)) break;
      if (it.status === 'expired' && ev.status === 'inbox') it.edits = { ...(it.edits || {}), dates: [] };
      it.status = ev.status; it.doneAt = ev.status === 'done' ? at : 0; it.updatedAt = at;
      break;
    }
    case 'item.source': {
      if (!it) break;
      const src = sanitizeSource(ev.source);
      if (!src || !(src.text || src.title)) break;
      // 題名だけ（YouTube の oEmbed など）のときは、説明欄を取りにいけるよう「取得待ち」のままにする
      const more = !src.text && it.platform === 'youtube' && it.fetch?.state === 'pending';
      it.source = src; it.fetch = more ? { ...it.fetch } : { state: 'ok', tries: 0, nextAt: 0, error: '' }; it.ai = null; it.aiTries = 0;
      refreshAuto(it, today); it.updatedAt = at;
      break;
    }
    case 'item.refetch': {
      if (!it || it.platform === 'memo') break;
      it.fetch = { state: 'pending', tries: 0, nextAt: 0, error: '' }; it.ai = null; it.aiTries = 0; it.updatedAt = at;
      break;
    }
    case 'item.want': {
      if (!it || !by) break;
      if (ev.off) it.by = it.by.filter(n => n !== by); else if (!it.by.includes(by)) it.by.push(by);
      it.updatedAt = at;
      break;
    }
    case 'item.delete': {
      if (!it) break;
      delete state.items[it.id];
      for (const p of Object.values(state.plans)) for (const s of p.slots || []) if (s.itemId === it.id) { s.itemId = null; s.reason = ''; }
      break;
    }
    case 'plan.set': {
      const p = sanitizePlan(ev.plan);
      if (p) state.plans[p.key] = p;
      break;
    }
    case 'plan.clear': {
      if (typeof ev.key === 'string') delete state.plans[ev.key];
      break;
    }
    case 'settings.set': {
      if ([1, 2, 3].includes(ev.pace)) state.settings.pace = ev.pace;
      if (has(CITIES, ev.city)) state.settings.city = ev.city;
      break;
    }
    case 'member.join': {
      if (by && !has(state.members, by)) state.members[by] = { joinedAt: at };
      break;
    }
    case 'member.remove': {   // 設定から外す（「行きたい」の印も外す）
      const name = safeName(ev.name);
      if (!name || !has(state.members, name)) break;
      delete state.members[name];
      for (const x of Object.values(state.items)) if (Array.isArray(x.by) && x.by.includes(name)) x.by = x.by.filter(n => n !== name);
      break;
    }
    case 'member.add': {   // 外したのを取り消す
      const name = safeName(ev.name);
      if (!name) break;
      if (!has(state.members, name)) state.members[name] = { joinedAt: Number(ev.joinedAt) || at };
      for (const id of Array.isArray(ev.itemIds) ? ev.itemIds.slice(0, 500) : []) {
        if (safeId(id) && has(state.items, id) && Array.isArray(state.items[id].by) && !state.items[id].by.includes(name)) state.items[id].by.push(name);
      }
      break;
    }
    default: break;
  }
  if (by && !has(state.members, by)) state.members[by] = { joinedAt: at };
  state.log.applied.push(ev.id);
  if (state.log.applied.length > MAX_APPLIED) state.log.applied.splice(0, state.log.applied.length - MAX_APPLIED);
  if (Number(ev.time) > state.log.lastTime) state.log.lastTime = Number(ev.time);
  state.updatedAt = Math.max(state.updatedAt || 0, at);
  return true;
}

export function sanitizePlan(p) {
  if (!p || typeof p !== 'object' || !validYmd(p.key)) return null;
  const days = Array.isArray(p.days) ? p.days.filter(validYmd).slice(0, MAX_WEEKEND_DAYS) : [];
  if (!days.length) return null;
  const slots = (Array.isArray(p.slots) ? p.slots : []).slice(0, 40)
    .filter(s => s && days.includes(s.date) && has(SLOT_DEF, s.slot))
    .map(s => ({ date: s.date, slot: s.slot, itemId: safeId(s.itemId) ? s.itemId : null, reason: str(s.reason, 80) }));
  const weather = {};
  for (const d of days) {
    const w = p.weather?.[d];
    if (w && typeof w === 'object') weather[d] = { code: Number(w.code) || 0, max: Number(w.max) || 0, min: Number(w.min) || 0, rain: Number(w.rain) || 0 };
  }
  return {
    key: p.key, days, slots, weather,
    skipped: Array.isArray(p.skipped) ? p.skipped.filter(safeId).slice(-60) : [],
    by: safeName(p.by) || 'auto', createdAt: Number(p.createdAt) || 0, closed: !!p.closed,
  };
}

// ---- 天気 ----
export const CITIES = {
  tokyo: { label: '東京', lat: 35.6812, lon: 139.7671 },
  yokohama: { label: '横浜', lat: 35.4437, lon: 139.638 },
  saitama: { label: 'さいたま', lat: 35.8617, lon: 139.6455 },
  chiba: { label: '千葉', lat: 35.6074, lon: 140.1065 },
  osaka: { label: '大阪', lat: 34.7025, lon: 135.4959 },
  kyoto: { label: '京都', lat: 35.0116, lon: 135.7681 },
  kobe: { label: '神戸', lat: 34.6901, lon: 135.1955 },
  nagoya: { label: '名古屋', lat: 35.1709, lon: 136.8815 },
  sapporo: { label: '札幌', lat: 43.0618, lon: 141.3545 },
  sendai: { label: '仙台', lat: 38.2682, lon: 140.8694 },
  hiroshima: { label: '広島', lat: 34.3853, lon: 132.4553 },
  fukuoka: { label: '福岡', lat: 33.5902, lon: 130.4017 },
  naha: { label: '那覇', lat: 26.2124, lon: 127.6809 },
};
export function weatherUrl(city) {
  const c = has(CITIES, city) ? CITIES[city] : CITIES.tokyo;
  return `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=14`;
}
export function parseWeather(json) {
  const d = json?.daily;
  const out = {};
  if (!d || !Array.isArray(d.time)) return out;
  d.time.forEach((t, i) => {
    out[t] = { code: d.weather_code?.[i] ?? 0, max: Math.round(d.temperature_2m_max?.[i] ?? 0), min: Math.round(d.temperature_2m_min?.[i] ?? 0), rain: d.precipitation_probability_max?.[i] ?? 0 };
  });
  return out;
}
export function weatherLabel(w) {
  if (!w) return null;
  const c = w.code;
  const text = c === 0 ? '快晴' : c <= 2 ? '晴れ' : c === 3 ? 'くもり' : c <= 48 ? '霧' : c <= 57 ? '小雨' : c <= 67 ? '雨' : c <= 77 ? '雪' : c <= 82 ? 'にわか雨' : c <= 86 ? '雪' : '雷雨';
  const icon = c <= 1 ? 'sun' : c <= 3 ? 'cloud' : c >= 71 && c <= 77 ? 'snow' : (c <= 48 ? 'cloud' : 'rain');
  return { text, icon };
}
export const isRainy = w => !!w && (w.rain >= 60 || (w.code >= 61 && w.code <= 67) || (w.code >= 80 && w.code <= 82) || w.code >= 95);
export const isFine = w => !!w && w.rain < 30 && w.code <= 3;

// ---- 割り振り ----
export const SLOT_DEF = {
  am: { label: '午前', time: '10:00', order: 0 },
  pm: { label: '午後', time: '14:00', order: 1 },
  night: { label: '夜', time: '18:30', order: 2 },
  day: { label: '1日', time: '9:00', order: 0 },
};
const SLOT_PREF = { morning: ['am'], day: ['pm', 'am'], night: ['night'], any: ['pm', 'am', 'night'] };

function hash01(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; }

// その日に行けるか（期間・定休日・平日限定）
export function eligibleOn(info, date) {
  if (info.weekdayOnly) return false;
  if (Array.isArray(info.closedDays) && info.closedDays.includes(dow(date))) return false;
  const ranges = (info.dates || []).filter(r => r.start || r.end);
  if (!ranges.length) return true;
  return ranges.some(r => (!r.start || r.start <= date) && (!r.end || date <= r.end));
}
export function lastDate(info) {
  const ends = (info.dates || []).map(r => r.end).filter(Boolean);
  if (!ends.length || (info.dates || []).some(r => !r.end)) return null;
  return ends.sort().at(-1);
}
export function isExpired(info, today) {
  const end = lastDate(info);
  return !!end && end < today;
}

export function candidates(state, wk, today) {
  const out = [];
  for (const item of Object.values(state.items)) {
    if (item.status !== 'inbox') continue;
    const info = effectiveInfo(item);
    if (isExpired(info, today)) continue;
    const days = wk.days.filter(d => d >= today && eligibleOn(info, d));
    if (days.length) out.push({ item, info, days });
  }
  return out;
}

function scoreOn(c, date, dayItems, weather, wkKey) {
  const { item, info } = c;
  const parts = [];
  let s = 50;
  const ranges = (info.dates || []).filter(r => (!r.start || r.start <= date) && (!r.end || date <= r.end));
  const single = ranges.find(r => r.start && r.start === r.end);
  if (single) { s += 60; parts.push([60, `${md(single.start)}だけの開催`]); }
  else {
    const ends = ranges.map(r => r.end).filter(Boolean).sort();
    if (ends.length) {
      const left = diffDays(date, ends[0]);
      if (left <= 1) { s += 45; parts.push([45, `${md(ends[0])}で終わるので今週末に`]); }
      else if (left <= 8) { s += 30; parts.push([30, `${md(ends[0])}までの開催`]); }
      else if (left <= 22) { s += 12; parts.push([12, `${md(ends[0])}まで`]); }
    }
    if (ranges.some(r => r.start === date)) { s += 8; parts.push([8, `${md(date)}から`]); }
  }
  const wants = (item.by || []).length;
  if (wants >= 2) { s += (wants - 1) * 12; parts.push([(wants - 1) * 12 + 1, `${wants}人が行きたい`]); }
  const age = Math.max(0, diffDays(jstToday(item.addedAt || Date.now()), date));
  s += Math.min(15, age / 2);
  if (age >= 21) parts.push([Math.min(15, age / 2), `ストックして${Math.floor(age / 7)}週間`]);
  if (item.postponed) { s += 8 * Math.min(3, item.postponed); parts.push([8 * Math.min(3, item.postponed), '前回見送った分']); }
  // 天気: 雨なら屋内、晴れなら屋外。暑すぎ・寒すぎる日は屋外を控えめに
  const w = weather?.[date];
  if (isRainy(w)) {
    if (info.indoor === false) s -= 60;
    else if (info.indoor === true) { s += 15; parts.push([15, w.rain ? `雨予報（${w.rain}%）なので屋内` : '雨予報なので屋内']); }
    else s -= 8;
  } else if (isFine(w) && info.indoor === false) { s += 14; parts.push([14, '晴れ予報なので外へ']); }
  if (w && w.max >= 32) {
    if (info.indoor === false) s -= 15;
    else if (info.indoor === true) { s += 6; parts.push([6, `暑い日（${w.max}℃）なので屋内`]); }
  } else if (w && w.max <= 8 && info.indoor === false) s -= 10;
  // 場所: 同じ日の予定と近いほど良い（住所から割り出した位置。無ければ同じエリア名）
  const others = dayItems.map(x => x.info);
  const dists = info.geo ? others.filter(o => o.geo).map(o => distKm(info.geo, o.geo)) : [];
  if (dists.length) {
    const far = Math.max(...dists);
    if (far <= 2) { s += 22; parts.push([22, `徒歩でまわれる近さ（${kmLabel(far)}）`]); }
    else if (far <= 7) { s += 12; parts.push([12, `近くでまとめて回れる（${kmLabel(far)}）`]); }
    else if (far > 25) s -= 30;
    else if (far > 15) s -= 12;
  } else if (info.area && others.some(o => o.area === info.area)) { s += 12; parts.push([12, `${info.area}でまとめて回れる`]); }
  if (others.some(o => o.category === info.category)) s -= 15;
  if (item.fetch?.state === 'pending' && !item.note) s -= 10;
  s += hash01(item.id + wkKey);
  parts.sort((a, b) => b[0] - a[0]);
  return { score: s, reason: parts.slice(0, 2).map(p => p[1]).join('・') || 'ストックから' };
}

export function freeSlotFor(info, taken, pace) {
  const used = taken.filter(t => t.itemId);
  if (used.some(t => t.slot === 'day')) return null;
  if (info.duration === 'full') return used.length ? null : 'day';
  if (used.length >= pace) return null;
  const pref = SLOT_PREF[info.timeOfDay] || SLOT_PREF.any;
  const fallback = info.timeOfDay === 'night' ? [] : ['pm', 'am', 'night'];
  for (const sl of [...pref, ...fallback]) if (!used.some(t => t.slot === sl)) return sl;
  return null;
}

// 週末の予定を割り振る。重い計算は無いので、ブラウザ（今すぐ割り振る）と Actions（木曜の自動）で共通に使う。
// keep: そのまま残す枠（行った予定・過ぎた日）
export function planWeekend(state, wk, { weather = {}, today, by = 'auto', now = Date.now(), skipped = [], keep = [] } = {}) {
  today = today || jstToday(now);
  const pace = [1, 2, 3].includes(state.settings?.pace) ? state.settings.pace : 2;
  const pool = candidates(state, wk, today).filter(c => !skipped.includes(c.item.id));
  const byDay = Object.fromEntries(wk.days.map(d => [d, []]));
  const used = new Set();
  for (const k of keep) {
    if (!has(byDay, k.date) || !has(state.items, k.itemId) || used.has(k.itemId)) continue;
    const it = state.items[k.itemId];
    used.add(k.itemId);
    byDay[k.date].push({ slot: k.slot, itemId: k.itemId, reason: k.reason || '', info: effectiveInfo(it), kept: true });
  }
  for (;;) {
    let best = null;
    for (const c of pool) {
      if (used.has(c.item.id)) continue;
      for (const d of c.days) {
        const slot = freeSlotFor(c.info, byDay[d], pace);
        if (!slot) continue;
        const { score, reason } = scoreOn(c, d, byDay[d], weather, wk.key);
        if (!best || score > best.score) best = { c, d, slot, score, reason };
      }
    }
    if (!best) break;
    used.add(best.c.item.id);
    byDay[best.d].push({ slot: best.slot, itemId: best.c.item.id, reason: best.reason, info: best.c.info });
  }
  const slots = [];
  for (const d of wk.days) {
    if (d < today && !byDay[d].some(x => x.kept)) continue;
    const list = byDay[d].sort((a, b) => SLOT_DEF[a.slot].order - SLOT_DEF[b.slot].order);
    for (const x of list) slots.push({ date: d, slot: x.slot, itemId: x.itemId, reason: x.reason });
  }
  const wx = {};
  for (const d of wk.days) if (weather[d]) wx[d] = weather[d];
  return { key: wk.key, days: wk.days, slots, weather: wx, skipped: [...skipped], by, createdAt: now, closed: false };
}

// その枠の時間帯に合うか（夜の店を午前に入れない・1日かかるものは「1日」枠だけ）
export function fitsSlot(info, slot) {
  if (slot === 'day') return true;                       // 「1日」枠の入れ替えは何でも（時間帯は入れたものに合わせる）
  if (info.duration === 'full') return false;
  const ok = { morning: ['am'], day: ['am', 'pm'], night: ['night'], any: ['am', 'pm', 'night'] }[info.timeOfDay] || ['am', 'pm', 'night'];
  return ok.includes(slot);
}

// ある枠に入れられる候補を、合う順に並べる（「入れ替え」「ストックから選ぶ」用）
// slot を渡すとその枠に合うものだけ、null ならその日の空き枠に入るものだけ
export function rankForSlot(state, plan, date, slot, { today } = {}) {
  today = today || jstToday();
  const wk = { key: plan.key, days: plan.days };
  const inPlan = new Set(plan.slots.map(s => s.itemId).filter(Boolean));
  const taken = plan.slots.filter(s => s.date === date && has(state.items, s.itemId) && s.slot !== slot);
  const dayItems = taken.map(s => ({ info: effectiveInfo(state.items[s.itemId]) }));
  return candidates(state, wk, today)
    .filter(c => !inPlan.has(c.item.id) && c.days.includes(date))
    .filter(c => (slot ? fitsSlot(c.info, slot) : !!freeSlotFor(c.info, taken, 3)))
    .map(c => ({ ...c, ...scoreOn(c, date, dayItems, plan.weather, plan.key), skipped: plan.skipped.includes(c.item.id) }))
    .sort((a, b) => (a.skipped - b.skipped) || b.score - a.score);
}

// 「入れ替え」: 今の予定を見送りに回し、次に合うものを入れる
export function swapSlot(state, plan, index, { today } = {}) {
  const p = structuredClone(plan);
  const s = p.slots[index];
  if (!s) return p;
  if (s.itemId && !p.skipped.includes(s.itemId)) p.skipped.push(s.itemId);
  const next = rankForSlot(state, p, s.date, s.slot, { today }).find(c => !c.skipped);
  s.itemId = next ? next.item.id : null;
  s.reason = next ? next.reason : '';
  if (next) s.slot = slotAfterReplace(state, p, index, next.info);
  return p;
}
// 入れ替えたあとの時間帯（「1日」枠に1日かからないものを入れたら、合う時間帯へ）
export function slotAfterReplace(state, plan, index, info) {
  const s = plan.slots[index];
  if (s.slot !== 'day') return s.slot;
  if (info.duration === 'full') return 'day';
  const taken = plan.slots.filter((x, i) => i !== index && x.date === s.date && has(state.items, x.itemId));
  return freeSlotFor(info, taken, 3) || 'pm';
}

// ---- 定期の片づけ（Actions が実行） ----
// 期間が過ぎた予定は「期限切れ」へ。終わった週末で行かなかったものは「前回見送り」を数える。
export function maintain(state, today) {
  let changed = false;
  for (const item of Object.values(state.items)) {
    if (item.status === 'inbox' && isExpired(effectiveInfo(item), today)) { item.status = 'expired'; changed = true; }
  }
  for (const p of Object.values(state.plans)) {
    if (p.closed || !p.days.length || p.days.at(-1) >= today) continue;
    for (const s of p.slots) {
      const it = has(state.items, s.itemId) ? state.items[s.itemId] : null;
      if (it && it.status === 'inbox') it.postponed = (it.postponed || 0) + 1;
    }
    p.closed = true; changed = true;
  }
  // 古い週末の記録は12週ぶんだけ残す
  const keys = Object.keys(state.plans).sort();
  while (keys.length > 12) { delete state.plans[keys.shift()]; changed = true; }
  return changed;
}

// ---- 表示用 ----
export function dateLabel(info, today) {
  const rs = (info.dates || []).filter(r => r.start || r.end);
  if (!rs.length) return null;
  const r = rs.find(x => !x.end || x.end >= today) || rs[0];
  if (r.start && r.end) return r.start === r.end ? `${mdw(r.start)}のみ` : `${md(r.start)}〜${md(r.end)}`;
  if (r.end) return `〜${md(r.end)}`;
  return `${md(r.start)}〜`;
}
export function closedLabel(info) {
  if (!Array.isArray(info.closedDays)) return null;
  if (!info.closedDays.length) return 'なし';
  return info.closedDays.map(n => DOW_JA[n]).join('・') + '曜';
}
export function weekendLabel(wk) {
  const a = wk.days[0], b = wk.days.at(-1);
  return a === b ? mdw(a) : `${mdw(a)}〜${mdw(b)}`;
}
export function daysUntilEnd(info, today) {
  const end = lastDate(info);
  return end ? diffDays(today, end) : null;
}
