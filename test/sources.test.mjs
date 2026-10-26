import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagram, parseThreads, parseGeneric, parseXOembed, parseYouTube, jsonStringAt, jsonLdLines } from '../sources.js';
import { extractInfo } from '../logic.js';

test('Instagram: og:title から本文と名前', () => {
  const html = `<meta property="og:title" content="Just An Egg &#x1f95a; on Instagram: &quot;Let&#x2019;s set a world record&#10;&#10;#LikeTheEgg&quot;" /><meta property="og:image" content="https://scontent.cdninstagram.com/x.jpg" />`;
  const r = parseInstagram(html);
  assert.equal(r.author, 'Just An Egg 🥚');
  assert.equal(r.text, 'Let’s set a world record\n\n#LikeTheEgg');
  assert.equal(r.thumb, 'https://scontent.cdninstagram.com/x.jpg');
});

test('Instagram: og:description からも取れる', () => {
  const html = `<meta property="og:description" content="120 likes, 4 comments - cafe_tokyo on October 20, 2026: &quot;表参道の新しいカフェ☕️&#10;📍渋谷区神宮前&quot;. " />`;
  const r = parseInstagram(html);
  assert.equal(r.author, 'cafe_tokyo');
  assert.equal(r.text, '表参道の新しいカフェ☕️\n📍渋谷区神宮前');
});

test('Instagram: 埋め込みページの本文', () => {
  const html = `<div class="Caption"><a class="CaptionUsername" href="#">cafe_tokyo</a><br/><br/>週末限定のパフェ<br/>📍中目黒<div class="CaptionComments">View all 3 comments</div></div>`;
  const r = parseInstagram(html);
  assert.equal(r.text, '週末限定のパフェ\n📍中目黒');
});

test('Threads と一般のサイト', () => {
  const th = parseThreads(`<meta property="og:title" content="Mark Zuckerberg (&#064;zuck) on Threads"><meta property="og:description" content="Let&#039;s do this.">`);
  assert.equal(th.author, 'Mark Zuckerberg (@zuck)');
  assert.equal(th.text, "Let's do this.");
  const g = parseGeneric(`<title>マルシェ 2026</title><meta name="description" content="11/1開催">`);
  assert.equal(g.title, 'マルシェ 2026');
  assert.equal(g.text, '11/1開催');
});

test('X の oEmbed', () => {
  const r = parseXOembed({ author_name: 'a', html: '<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">渋谷で古着市<br>11/1 <a href="https://t.co/x">pic.twitter.com/abc</a></p>&mdash; a (@a)</blockquote>' });
  assert.equal(r.text, '渋谷で古着市\n11/1');
});

test('巨大なページや壊れた文字参照でも固まらない・落ちない', () => {
  const t0 = Date.now();
  const r = parseGeneric(`<meta property="og:title" content="${'a'.repeat(1_000_000)}`);
  assert.ok(Date.now() - t0 < 1000, '1秒以内');
  assert.equal(r, null);
  assert.equal(parseGeneric('<meta name="description" content="x&#x110000;y&#55296;z">').text, 'xyz');
});

test('Instagram: 2026年の og:title「名前 - Instagram: "本文"」と og:description「日付、… - user: "本文".」', () => {
  const html = `<meta property="og:title" content="Just An Egg &#x1f95a; - Instagram: &quot;Let&#x2019;s set a world record&#10;&#10;#LikeTheEgg&quot;" />`;
  const r = parseInstagram(html);
  assert.equal(r.author, 'Just An Egg 🥚');
  assert.equal(r.text, 'Let’s set a world record\n\n#LikeTheEgg');
  const d = parseInstagram(`<meta property="og:description" content="January 4, 2019、60M likes, 4M comments - world_record_egg: &quot;表参道のカフェ&#10;📍渋谷区神宮前&quot;. " />`);
  assert.equal(d.author, 'world_record_egg');
  assert.equal(d.text, '表参道のカフェ\n📍渋谷区神宮前');
});

test('Threads: 日本語のページの og:title「Threadsの名前 (@user)」', () => {
  const r = parseThreads(`<meta property="og:title" content="ThreadsのMark Zuckerberg (@zuck)"><meta property="og:description" content="Let&#039;s do this.">`);
  assert.equal(r.author, 'Mark Zuckerberg (@zuck)');
});

test('YouTube: 説明欄の全文（shortDescription）と投稿者', () => {
  const html = `<meta property="og:title" content="週末マルシェ"><meta property="og:description" content="11/1開催…">
    <script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"11月1日(土) 開催\\n会場: 代々木公園 \\"けやき並木\\"\\n入場無料","ownerChannelName":"マルシェ実行委員会"}};</script>`;
  const r = parseYouTube(html);
  assert.equal(r.title, '週末マルシェ');
  assert.equal(r.text, '11月1日(土) 開催\n会場: 代々木公園 "けやき並木"\n入場無料');
  assert.equal(r.author, 'マルシェ実行委員会');
  assert.equal(parseYouTube('<title>YouTube</title><meta name="description" content="YouTube でお気に入りの動画や音楽を楽しみ、オリジナルのコンテンツをアップロードして友だちや家族、世界中の人たちと共有しましょう。">'), null, '確認用ページの決まり文句は本文にしない');
  assert.equal(jsonStringAt('{"a":"x', 'a'), '', '閉じていない文字列は空');
  assert.equal(jsonStringAt('{"a":"\\ud800"}', 'a').length, 1, '壊れた文字でも落ちない');
});

test('一般のサイト: 埋め込みのイベント情報（JSON-LD）を行にして本文の先頭に置く', () => {
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', name: 'x' },
    { '@type': 'ExhibitionEvent', name: '冬のクラフト展', startDate: '2026-12-19T11:00:00+09:00', endDate: '2026-12-20',
      location: { '@type': 'Place', name: '表参道ヒルズ', address: { '@type': 'PostalAddress', addressRegion: '東京都', addressLocality: '渋谷区', streetAddress: '神宮前4-12-10' } },
      offers: { '@type': 'Offer', price: '1000', priceCurrency: 'JPY' } },
  ] };
  const html = `<title>冬のクラフト展</title><meta name="description" content="手しごとの展示即売会">
    <script type="application/ld+json">${JSON.stringify(ld)}</script><script type="application/ld+json">{broken</script>
    <script type="application/ld+json">{"@type":"CafeOrCoffeeShop","name":"喫茶ひだまり","address":"東京都目黒区中目黒1-1-1","openingHours":["Tu-Su 10:00-18:00"]}</script>`;
  const r = parseGeneric(html);
  assert.equal(r.title, '冬のクラフト展');
  assert.deepEqual(r.text.split('\n'), [
    'イベント: 冬のクラフト展', '開催期間: 2026-12-19〜2026-12-20', '会場: 表参道ヒルズ', '住所: 東京都 渋谷区 神宮前4-12-10', '料金: 1000円',
    '店名: 喫茶ひだまり', '住所: 東京都目黒区中目黒1-1-1', '営業時間: Tu-Su 10:00-18:00', '手しごとの展示即売会',
  ]);
  const ev = parseGeneric(`<title>冬のクラフト展</title><script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  const info = extractInfo({ text: ev.text, title: ev.title, platform: 'web' }, '2026-11-01');
  assert.deepEqual(info.dates, [{ start: '2026-12-19', end: '2026-12-20' }]);
  assert.equal(info.place, '表参道ヒルズ');
  assert.equal(info.area, '表参道');
  const cafe = parseGeneric(`<title>喫茶ひだまり</title><script type="application/ld+json">{"@type":"CafeOrCoffeeShop","name":"喫茶ひだまり","address":"東京都目黒区中目黒1-1-1"}</script>`);
  const ci = extractInfo({ text: cafe.text, title: cafe.title, platform: 'web' }, '2026-11-01');
  assert.equal(ci.place, '喫茶ひだまり');
  assert.deepEqual(ci.dates, []);
});

test('JSON-LD: 巨大・大量・入れ子が深くても固まらない', () => {
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  const html = `<script type="application/ld+json">${deep}</script>`.repeat(20) + `<script type="application/ld+json">${'x'.repeat(200000)}</script>`;
  const t0 = Date.now();
  assert.deepEqual(jsonLdLines(html), []);
  assert.ok(Date.now() - t0 < 1000, '1秒以内');
});
