import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTiebaArticle, parseTiebaList } from '../providers';
import { parseLink } from '../model';
import { renderArticle } from '../render';

// Minimal DOM recorded from the signed-in Edge page on 2026-11-09.
// https://tieba.baidu.com/p/11177679262?fr=frs
const livePost = `<div class="center-content"><a class="head-name"> 坂田银时😎 </a>
<span class="pb-title"><!----> 打完影之刃，电子阳苇了，有类似的代餐推荐吗 </span>
<div class="pb-content-wrap"><div class="richtext-item"><span class="pb-text-wrapper" index="0" content="[object Object]" fid="707597" tid="11177679262" order-id="0"><span>主角性能不能太残疾的那种</span></span></div>
<div class="richtext-item"><div class="image-card-wrapper"><div class="lazy-img-wrapper tbfe-1px-border cursor-pointer"><img src="https://tiebapic.baidu.com/test.jpg"></div></div></div></div>
<div class="pb-comment-item" data-id="154119131978"><a class="head-name"> 坂田银时😎 </a><div class="comment-content"><div class="pb-rich-text"><div class="pb-content-item"><span class="pb-text-wrapper text"><span>真的好久没有这么一款游戏，让我如此沉浸下去的玩了.哪怕当年黑猴首发，都没这种感觉.</span></span></div><div class="pb-content-item"><!----></div></div></div></div>
<div class="pb-comment-item" data-id="154119144890"><a class="head-name"> 坂田银时😎 </a><div class="comment-content"><div class="pb-rich-text"><div class="pb-content-item"><span class="pb-text-wrapper text"><span>突然想到卡赞跟影之刃其实也挺类似的，战斗爽，探图也舒适，恶心人的地方也少.主角性能也强.</span></span></div></div></div></div></div>`;

test('real modern Edge thread DOM produces the title, main body and distinct floor IDs', () => {
  const article = parseTiebaArticle(livePost, parseLink('https://tieba.baidu.com/p/11177679262'));
  assert.equal(article.title, '打完影之刃，电子阳苇了，有类似的代餐推荐吗');
  assert.equal(article.sections.length, 3);
  assert.equal(article.sections[0].author, '坂田银时😎');
  assert.match(article.sections[0].html, /主角性能不能太残疾的那种/);
  assert.equal(article.sections[1].id, '154119131978');
  assert.equal(article.sections[2].id, '154119144890');
  const rendered = renderArticle(article, { images: false, fontSize: 15, saved: false });
  assert.match(rendered, /主角性能不能太残疾的那种/);
  assert.match(rendered, /真的好久没有这么一款游戏/);
});

test('modern thread cards select the nested title instead of authors, excerpts or reply counts', () => {
  const html = `<div class="thread-card virtual-list-item"><div class="thread-card-wrapper"><a href="https://tieba.baidu.com/p/11177679262?fr=frs" class="thread-content-link"><div class="head-line"><a class="head-name">坂田银时😎</a></div><div class="thread-link-zone"><div class="thread-title"><div class="tb-richtext title-richtext"><span class="text">打完影之刃，电子阳苇了，有类似的代餐推荐吗</span></div></div><div class="thread-content">主角性能不能太残疾的那种</div></div></a><div class="thread-action-area"><a class="comment-link-zone" href="/p/11177679262?showComment=1"><span class="action-number">129</span></a></div></div></div>`;
  const entries = parseTiebaList(html);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, '打完影之刃，电子阳苇了，有类似的代餐推荐吗');
  assert.equal(entries[0].summary, '主角性能不能太残疾的那种');
  assert.equal(parseTiebaList('<a class="comment-link-zone" href="/p/123">129</a>').length, 0);
});

test('modern nested replies stay separate from floor content and preserve the remaining reply count', () => {
  const html = `<div class="pb-comment-item" data-id="123"><a class="head-name">楼层作者</a><div class="comment-content"><div class="pb-rich-text">楼层正文</div><div class="pc-pb-comments-desc">第3楼 回复</div><div class="lzl-wrapper"><div class="pb-lzl-item"><a class="head-name">回复者</a><div class="comment-content"><div class="pb-rich-text">楼中楼正文</div><div class="pc-pb-comments-desc">回复</div></div></div><div class="show-more-lzl">展开 3 条回复</div></div></div></div>`;
  const article = parseTiebaArticle(html, parseLink('https://tieba.baidu.com/p/1'));
  assert.match(article.sections[0].html, /楼层正文/);
  assert.ok(!article.sections[0].html.includes('楼中楼正文'));
  assert.equal(article.sections[0].tiebaReplyCount, 4);
  assert.equal(article.sections[0].tiebaReplyPreview?.[0].author, '回复者');
  assert.match(renderArticle(article, { images: false, fontSize: 15, saved: false }), /展开剩余 3 条回复/);
});

test('verified deepseek page title and body use the same modern DOM adapter', () => {
  // Recorded after manual verification at /p/11136211439 on 2026-11-09.
  const html = `<div class="center-content"><a class="head-name">贴吧用户_aX25b66</a><span class="pb-title">求助 clash 是不是没有用武之地了</span><div class="pb-content-wrap"><div class="richtext-item"><span>好像现在都是用自研客户端的，clash 能用的都是废掉的🪢。要执着于 clash 吗？ 要买个自研的吗？</span></div></div><div class="pb-comment-item" data-id="154073221612"><a class="head-name">但念人长久</a><div class="comment-content"><div class="pb-rich-text">什么自研不还是套壳，正常人谁用自研客户端，都避之不及</div></div></div></div>`;
  const result = parseTiebaArticle(html, parseLink('https://tieba.baidu.com/p/11136211439'));
  assert.equal(result.title, '求助 clash 是不是没有用武之地了');
  assert.match(result.sections[0].html, /要执着于 clash 吗/);
  assert.equal(result.sections[1].id, '154073221612');
  assert.match(renderArticle(result, { images: false, fontSize: 15, saved: false }), /什么自研不还是套壳/);
});
