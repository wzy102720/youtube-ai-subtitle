const test = require('node:test');
const assert = require('node:assert/strict');
const {createHarness, transcript, answerDeepSeek, flush} = require('./helpers/userscript-harness.cjs');

const longBody = () => transcript(Array.from({length: 13}, (_, i) => `Sentence ${i + 1}.`));
function respondAll(request) {
  const lines = JSON.parse(request.data).messages[1].content.split('\n');
  answerDeepSeek(request, lines.map((line, i) => `[${i + 1}] ${line.replace(/^\[\d+\] /, '')}的译文`).join('\n'));
}
const input = request => JSON.parse(request.data).messages[1].content;
const mobile = {engine: 'deepseek', origin: 'https://m.youtube.com'};

test('手机切后台中断在途请求，已译进度落盘；回前台仅重发未完成批次', async () => {
  const h = createHarness({...mobile, respond(request, i) { if (i === 0) respondAll(request); }});
  await h.capture('A', longBody());
  assert.equal(h.progress().length, 1);
  assert.equal(JSON.parse(h.progress()[0][1]).cues.filter(c => c.tgt).length, 12);
  assert.equal(h.caches().length, 0);
  await h.clock.advance(200);
  const interrupted = h.requests[1];
  await h.setHidden(true);
  assert.equal(interrupted.aborted, true);
  assert.match(h.ids.get('ytdsk-debug').textContent, /暂停.*12\/13/);
  await h.clock.advance(200000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.targetText(), 'Sentence 1.的译文');
  await h.setHidden(false);
  assert.equal(h.requests.length, 3);
  assert.equal(input(h.requests[2]), '[1] Sentence 13.');
  answerDeepSeek(interrupted, '[1] 不能接收迟到的旧译文');
  respondAll(h.requests[2]); await flush();
  assert.equal(h.progress().length, 0);
  const cache = JSON.parse(h.caches()[0][1]);
  assert.equal(cache.complete, true);
  assert.equal(cache.cues.length, 13);
  assert.equal(cache.cues[12].tgt, 'Sentence 13.的译文');
});

test('后台加载的手机页面不发送翻译请求，回到前台后正常处理', async () => {
  const h = createHarness({...mobile, hidden: true});
  await h.capture();
  await h.clock.advance(60000);
  assert.equal(h.requests.length, 0);
  await h.setHidden(false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.targetText(), '深度求索译文1。');
});

test('冻结和恢复事件能恢复请求；仍隐藏时不会提前请求', async () => {
  const h = createHarness({...mobile, respond: () => {}});
  await h.capture();
  await h.lifecycle('freeze');
  assert.equal(h.requests[0].aborted, true);
  await h.setHidden(true);
  await h.lifecycle('resume');
  assert.equal(h.requests.length, 1);
  await h.setHidden(false);
  assert.equal(h.requests.length, 2);
  respondAll(h.requests[1]); await flush();
  assert.equal(h.caches().length, 1);
});

test('从前后退缓存恢复页面时继续翻译，不把 pagehide 当作任务永久取消', async () => {
  const h = createHarness({...mobile, respond: () => {}});
  await h.capture();
  await h.lifecycle('pagehide', {persisted: true});
  assert.equal(h.requests[0].aborted, true);
  await h.clock.advance(60000);
  assert.equal(h.requests.length, 1);
  await h.lifecycle('pageshow', {persisted: true});
  assert.equal(h.requests.length, 2);
  respondAll(h.requests[1]); await flush();
  assert.equal(h.caches().length, 1);
});

test('页面被回收重载后，恢复 12 条已译进度，只翻译剩余一条', async () => {
  const first = createHarness({...mobile, respond(request, i) { if (i === 0) respondAll(request); }});
  await first.capture('A', longBody());
  const restored = createHarness({...mobile, storage: [...first.storage]});
  await restored.capture('A', longBody());
  assert.equal(restored.requests.length, 1);
  assert.equal(input(restored.requests[0]), '[1] Sentence 13.');
  assert.equal(restored.caches().length, 1);
  assert.equal(restored.progress().length, 0);
});

test('DeepSeek 漏行时先保存有效译文，仅重试缺失的行', async () => {
  const h = createHarness({...mobile, respond(request, i) {
    if (i === 0) answerDeepSeek(request, '[1] 第一句译文。');
    else answerDeepSeek(request, '[1] 第二句译文。');
  }});
  await h.capture('A', transcript(['First.', 'Second.']));
  assert.equal(h.targetText(), '第一句译文。');
  assert.equal(h.progress().length, 1);
  assert.equal(h.caches().length, 0);
  await h.clock.advance(500);
  assert.equal(h.requests.length, 2);
  assert.equal(input(h.requests[1]), '[1] Second.');
  assert.deepEqual(JSON.parse(h.caches()[0][1]).cues.map(c => c.tgt), ['第一句译文。', '第二句译文。']);
});

test('某批持续格式异常，不阻断后续批次；手动继续时跳过已成功字幕', async () => {
  let recovered = false;
  const h = createHarness({...mobile, respond(request, i) {
    if (i < 3 && !recovered) answerDeepSeek(request, 'invalid output');
    else respondAll(request);
  }});
  await h.capture('A', longBody());
  await h.clock.advance(1700);
  assert.equal(h.requests.length, 4);
  assert.equal(h.caches().length, 0);
  assert.equal(JSON.parse(h.progress()[0][1]).cues.filter(c => c.tgt).length, 1);
  assert.match(h.ids.get('ytdsk-debug').textContent, /已保留译文 1\/13/);
  recovered = true;
  await h.retry();
  assert.equal(h.requests.length, 5);
  assert.doesNotMatch(input(h.requests[4]), /Sentence 13\./);
  assert.equal(h.caches().length, 1);
});

test('重试耗尽仍保留部分译文，不能把断点当作完整成功缓存', async () => {
  const h = createHarness({...mobile, respond(request, i) {
    answerDeepSeek(request, i === 0 ? '[1] 第一句译文。' : '');
  }});
  await h.capture('A', transcript(['First.', 'Second.']));
  await h.clock.advance(1500);
  assert.equal(h.requests.length, 3);
  assert.equal(h.caches().length, 0);
  assert.equal(JSON.parse(h.progress()[0][1]).complete, false);
  assert.equal(h.targetText(), '第一句译文。');
  assert.match(h.ids.get('ytdsk-debug').textContent, /已保留译文 1\/2/);
});

test('油猴管理器自行中断请求时有限重试，不会静默卡在翻译中', async () => {
  const h = createHarness({...mobile, respond(request, i) {
    if (i === 0) request.onabort(); else respondAll(request);
  }});
  await h.capture();
  await h.clock.advance(500);
  assert.equal(h.requests.length, 2);
  assert.equal(h.caches().length, 1);
});

test('反复切后台不消耗网络失败次数，也不会同时启动重复请求', async () => {
  const h = createHarness({...mobile, respond: () => {}});
  await h.capture();
  for (let i = 0; i < 6; i++) {
    await h.setHidden(true);
    assert.equal(h.requests.at(-1).aborted, true);
    await h.setHidden(false);
    assert.equal(h.requests.length, i + 2);
  }
  respondAll(h.requests.at(-1)); await flush();
  assert.equal(h.caches().length, 1);
});

test('鉴权失败显示 HTTP 原因，切回前台也不会反复消耗无效请求', async () => {
  const h = createHarness({...mobile, respond: request => request.onload({status: 401, responseText: '{}'})});
  await h.capture();
  await h.setHidden(true); await h.setHidden(false);
  await h.clock.advance(2000);
  assert.equal(h.requests.length, 1);
  assert.match(h.ids.get('ytdsk-debug').textContent, /HTTP 401/);
});

test('失败后回到前台可从进度续译，不重复翻译成功的前一批', async () => {
  let offline = true;
  const h = createHarness({...mobile, respond(request, i) {
    if (i === 0 || !offline) respondAll(request);
    else request.onerror();
  }});
  await h.capture('A', longBody()); await h.clock.advance(1700);
  assert.equal(h.requests.length, 4);
  assert.equal(h.caches().length, 0);
  offline = false;
  await h.setHidden(true); await h.setHidden(false);
  assert.equal(h.requests.length, 5);
  assert.equal(input(h.requests[4]), '[1] Sentence 13.');
  assert.equal(h.caches().length, 1);
});

test('后台期间切换视频，回前台只能翻译新视频', async () => {
  const h = createHarness({...mobile, respond: () => {}});
  await h.capture('A', transcript(['Old video.']));
  await h.setHidden(true);
  await h.navigate('B'); await h.capture('B', transcript(['New video.']));
  assert.equal(h.requests.length, 1);
  await h.setHidden(false);
  assert.equal(h.requests.length, 2);
  assert.equal(input(h.requests[1]), '[1] New video.');
  respondAll(h.requests[1]); await flush();
  assert.equal(JSON.parse(h.caches()[0][1]).videoId, 'B');
  assert.equal(h.sourceText(), 'New video.');
});

test('损坏进度和不匹配的字幕内容不能复用；清除缓存同时删除进度', async () => {
  const first = createHarness({...mobile, respond(request, i) { if (i === 0) respondAll(request); }});
  await first.capture('A', longBody());
  const [key, text] = first.progress()[0];
  const damaged = JSON.parse(text); damaged.cues[0].src = 'wrong transcript';
  first.storage.set(key, JSON.stringify(damaged));
  const restored = createHarness({...mobile, storage: [...first.storage], respond: () => {}});
  await restored.capture('A', longBody());
  assert.equal(input(restored.requests[0]).split('\n').length, 12);
  assert.equal(restored.targetText(), '');
  restored.storage.set('yt-progress-B-keep', 'other video');
  await restored.clearCache();
  assert.equal(restored.storage.has(key), false);
  assert.equal(restored.storage.get('yt-progress-B-keep'), 'other video');
});

test('Google 同样可以恢复部分进度，不把成功行重新发送', async () => {
  const first = createHarness({respond(request) {
    if (new URL(request.url).searchParams.get('q') === 'Second.') request.onerror();
    else request.onload({status: 200, responseText: JSON.stringify([[['第一句译文。']]])});
  }});
  const body = transcript(['First.', 'Second.']);
  await first.capture('A', body); await first.clock.advance(1500);
  const restored = createHarness({storage: [...first.storage]});
  await restored.capture('A', body);
  assert.equal(restored.requests.length, 1);
  assert.equal(new URL(restored.requests[0].url).searchParams.get('q'), 'Second.');
  assert.equal(restored.caches().length, 1);
});
