import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagram, parseThreads, parseGeneric, parseXOembed } from '../sources.js';

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
