const test = require('node:test');
const assert = require('node:assert/strict');
const {createHarness, transcript, answerDeepSeek, flush} = require('./helpers/userscript-harness.cjs');

test('切换视频会取消旧请求，旧响应不能覆盖新视频或写入缓存', async () => {
  const h = createHarness({engine: 'deepseek', respond: () => {}});
  await h.capture('A', transcript(['Video A.']));
  const oldRequest = h.requests[0];
  await h.navigate('B');
  assert.equal(oldRequest.aborted, true);
  assert.equal(h.sourceText(), '');
  assert.equal(h.nativeHidden(), false);
  await h.capture('B', transcript(['Video B.']));
  answerDeepSeek(h.requests[1], '[1] 视频 B 的译文。');
  await flush();
  answerDeepSeek(oldRequest, '[1] 已取消的 A。');
  await flush();
  assert.equal(h.sourceText(), 'Video B.');
  assert.equal(h.targetText(), '视频 B 的译文。');
  assert.equal(h.caches().length, 1);
  assert.equal(JSON.parse(h.caches()[0][1]).videoId, 'B');
});

test('字幕等待超时后保留原生字幕，迟到的 CC 可以自动恢复', async () => {
  const h = createHarness();
  await h.clock.advance(31000);
  assert.equal(h.nativeHidden(), false);
  assert.equal(h.sourceText(), '');
  await h.capture();
  assert.equal(h.sourceText(), 'Hello there.');
  assert.equal(h.targetText(), '谷歌译文。');
  assert.equal(h.nativeHidden(), true);
});

test('Google 连续限流会重试，失败结果不缓存；刷新后可重新翻译', async () => {
  const h = createHarness({respond: request => request.onload({status: 429, responseText: '{}'})});
  const body = transcript(['First sentence.', 'Second sentence.']);
  await h.capture('A', body);
  await h.clock.advance(1500);
  assert.equal(h.requests.length, 6);
  assert.equal(h.caches().length, 0);
  assert.equal(h.targetText(), '');
  assert.match(h.ids.get('ytdsk-debug').textContent, /未完成/);
  const reloaded = createHarness({storage: [...h.storage]});
  await reloaded.capture('A', body);
  assert.equal(reloaded.requests.length, 2);
  assert.equal(reloaded.caches().length, 1);
});

for (const [name, content, reason] of [
  ['重复编号', '[1] 第一行。\n[1] 重复行。\n[2] 第二行。', 'stop'],
  ['无效编号', '[1] 第一行。\n[3] 第三行。', 'stop'],
  ['截断', '[1] 第一行。\n[2] 第二行。', 'length'],
  ['服务端中断', '[1] 第一行。\n[2] 第二行。', 'aborted'],
  ['资源不足', '[1] 第一行。\n[2] 第二行。', 'insufficient_system_resource'],
  ['内容过滤', '[1] 第一行。\n[2] 第二行。', 'content_filter'],
  ['空结果', '', 'stop'],
]) {
  test(`DeepSeek ${name}会有限重试且不写入成功缓存`, async () => {
    const h = createHarness({engine: 'deepseek', respond: request => answerDeepSeek(request, content, reason)});
    await h.capture('A', transcript(['First.', 'Second.']));
    await h.clock.advance(1500);
    assert.equal(h.requests.length, 3);
    assert.equal(h.caches().length, 0);
    assert.equal(h.targetText(), '');
  });
}

test('Google 部分失败时保留成功译文，但整个结果不能标记为完整缓存', async () => {
  const h = createHarness({respond(request) {
    const text = new URL(request.url).searchParams.get('q');
    if (text === 'Second.') request.onload({status: 403, responseText: '{}'});
    else request.onload({status: 200, responseText: JSON.stringify([[['第一句译文。']]])});
  }});
  await h.capture('A', transcript(['First.', 'Second.']));
  assert.equal(h.targetText(), '第一句译文。');
  assert.equal(h.caches().length, 0);
});

test('暂停在同一句时，译文完成后立即更新画面', async () => {
  const h = createHarness({engine: 'deepseek', respond: () => {}});
  await h.capture();
  assert.equal(h.sourceText(), 'Hello there.');
  assert.equal(h.targetText(), '');
  answerDeepSeek(h.requests[0], '[1] 你好。');
  await flush();
  assert.equal(h.video.currentTime, 1);
  assert.equal(h.targetText(), '你好。');
});

test('长静音两侧的字幕保持各自区间，静音中不显示未来台词', async () => {
  const h = createHarness();
  await h.capture('A', transcript(['Before the break', 'After the break.'], {
    starts: [0, 30000], durations: [2000, 2000],
  }));
  const cues = JSON.parse(h.caches()[0][1]).cues;
  assert.deepEqual(cues.map(cue => [cue.start, cue.end]), [[0, 2], [30, 32]]);
  await h.frame(15);
  assert.equal(h.sourceText(), '');
  assert.equal(h.nativeHidden(), false);
  await h.frame(31);
  assert.equal(h.sourceText(), 'After the break.');
});

test('非英语字幕沿用十秒上限，在加入下一段之前检查长度', async () => {
  const h = createHarness();
  await h.capture('A', transcript(['Primera parte', 'Segunda parte'], {starts: [0, 6000], durations: [6000, 6000]}), 'es');
  const cues = JSON.parse(h.caches()[0][1]).cues;
  assert.equal(cues.length, 2);
  assert.ok(cues.every(cue => cue.end - cue.start <= 10));
});

test('滚动追加字幕的原始结束时间不能被后续静音拉长', async () => {
  const h = createHarness();
  const body = JSON.stringify({events: [
    {tStartMs: 0, dDurationMs: 2000, segs: [{utf8: 'Before the break'}]},
    {tStartMs: 30000, dDurationMs: 2000, aAppend: 1, segs: [{utf8: 'After the break.'}]},
  ]});
  await h.capture('A', body);
  const cues = JSON.parse(h.caches()[0][1]).cues;
  assert.deepEqual(cues.map(cue => [cue.start, cue.end]), [[0, 2], [30, 32]]);
  await h.frame(15);
  assert.equal(h.sourceText(), '');
});

test('DeepSeek 两批之间切换视频，不会继续发送旧视频后续批次', async () => {
  const h = createHarness({engine: 'deepseek'});
  await h.capture('A', transcript(Array.from({length: 13}, (_, index) => `Sentence ${index + 1}.`)));
  assert.equal(h.requests.length, 1);
  await h.navigate('B');
  await h.capture('B', transcript(['Video B.']));
  await h.clock.advance(1000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.sourceText(), 'Video B.');
  assert.equal(h.caches().length, 1);
  assert.equal(JSON.parse(h.caches()[0][1]).videoId, 'B');
});

test('改变目标语言时不会读取其他目标语言的缓存', async () => {
  const first = createHarness();
  await first.capture();
  const other = createHarness({storage: [...first.storage], target: 'ja'});
  await other.capture();
  assert.equal(other.requests.length, 1);
  assert.equal(new URL(other.requests[0].url).searchParams.get('tl'), 'ja');
  assert.equal(other.caches().length, 2);
});

test('同引擎复用完整缓存，切换引擎后生成新的译文', async () => {
  const google = createHarness();
  const body = transcript();
  await google.capture('A', body);
  const same = createHarness({storage: [...google.storage]});
  await same.capture('A', body);
  assert.equal(same.requests.length, 0);
  assert.equal(same.targetText(), '谷歌译文。');
  google.menus.find(menu => menu.label.startsWith('切换引擎')).callback();
  const deepseek = createHarness({storage: [...google.storage]});
  await deepseek.capture('A', body);
  assert.equal(deepseek.requests.length, 1);
  assert.equal(deepseek.targetText(), '深度求索译文1。');
  assert.equal(deepseek.caches().length, 2);
});

test('同一视频切换字幕轨道，会重新解析和翻译', async () => {
  const h = createHarness();
  await h.capture('A', transcript(['An English sentence.']), 'en');
  await h.capture('A', transcript(['Una frase en espanol.']), 'es');
  assert.equal(h.sourceText(), 'Una frase en espanol.');
  assert.equal(h.requests.length, 2);
  assert.equal(h.caches().length, 2);
});

test('轨道切换期间取消旧翻译，不接受旧轨道迟到的响应', async () => {
  const h = createHarness({engine: 'deepseek', respond: () => {}});
  await h.capture('A', transcript(['English.']), 'en');
  await h.capture('A', transcript(['Espanol.']), 'es');
  assert.equal(h.requests[0].aborted, true);
  answerDeepSeek(h.requests[1], '[1] 新字幕轨道。');
  answerDeepSeek(h.requests[0], '[1] 旧字幕轨道。');
  await flush();
  assert.equal(h.sourceText(), 'Espanol.');
  assert.equal(h.targetText(), '新字幕轨道。');
  assert.equal(h.caches().length, 1);
});

test('字幕请求乱序返回时，旧请求不能取代后发请求的轨道', async () => {
  const h = createHarness();
  const old = h.beginCapture('A', 'en');
  const current = h.beginCapture('A', 'es');
  await current.respond(transcript(['Espanol.']));
  await old.respond(transcript(['English.']));
  assert.equal(h.sourceText(), 'Espanol.');
  assert.equal(h.requests.length, 1);
});

for (const [source, target, text, translate] of [
  ['zh-TW', 'zh-CN', '這是一個測試。', true],
  ['zh-Hant', 'zh-CN', '這是一個測試。', true],
  ['zh-CN', 'zh-TW', '这是一个测试。', true],
  ['zh-Hans', 'zh-CN', '这是一个测试。', false],
  ['zh-Hant-HK', 'zh-TW', '這是一個測試。', false],
  ['zh', 'zh-CN', '这是中文。', true],
  ['en', 'en', 'An English sentence.', false],
]) {
  test(`语言比较 ${source} → ${target}：${translate ? '调用翻译' : '明确同语言时跳过'}`, async () => {
    const h = createHarness({target});
    await h.capture('A', transcript([text]), source);
    assert.equal(h.requests.length, translate ? 1 : 0);
    assert.equal(h.targetText(), translate ? '谷歌译文。' : text);
  });
}

test('YouTube 已自动翻译的字幕以 tlang 作为正文语言', async () => {
  const h = createHarness({target: 'en'});
  await h.capture('A', transcript(['Already in English.']), 'es', {tlang: 'en'});
  assert.equal(h.requests.length, 0);
  assert.equal(h.targetText(), 'Already in English.');
});

test('同语言不同字幕类型不能混用缓存；完全相同的响应不会重复翻译', async () => {
  const h = createHarness();
  const body = transcript();
  await h.capture('A', body, 'en', {kind: 'asr'});
  await h.capture('A', body, 'en', {kind: 'asr'});
  assert.equal(h.requests.length, 1);
  await h.capture('A', body, 'en');
  assert.equal(h.requests.length, 2);
});

test('旧版缓存和损坏的成功缓存都不会阻止重新翻译', async () => {
  const h = createHarness({storage: [['yt-trans-A-zh-CN', JSON.stringify({v: 2, cues: []})]]});
  const body = transcript();
  await h.capture('A', body);
  const [key, value] = h.caches().find(([name]) => name.includes('-v3-'));
  const corrupted = JSON.parse(value);
  corrupted.cues[0].tgt = '';
  h.storage.set(key, JSON.stringify(corrupted));
  const reloaded = createHarness({storage: [...h.storage]});
  await reloaded.capture('A', body);
  assert.equal(reloaded.requests.length, 1);
  assert.equal(reloaded.targetText(), '谷歌译文。');
});

test('清除缓存会删除当前视频的所有变体并立即重试，不影响其他视频', async () => {
  const h = createHarness({storage: [
    ['yt-trans-A-zh-CN', 'old'], ['yt-trans-A-another-engine', 'old'], ['yt-trans-B-zh-CN', 'keep'],
  ]});
  await h.capture();
  await h.clearCache();
  assert.equal(h.storage.has('yt-trans-A-zh-CN'), false);
  assert.equal(h.storage.has('yt-trans-A-another-engine'), false);
  assert.equal(h.storage.get('yt-trans-B-zh-CN'), 'keep');
  assert.equal(h.requests.length, 2);
  assert.equal(h.caches().filter(([key]) => key.startsWith('yt-trans-A-')).length, 1);
});

test('离开视频页面会清理画面、恢复原生字幕并取消请求', async () => {
  const h = createHarness({engine: 'deepseek', respond: () => {}});
  await h.capture();
  assert.equal(h.nativeHidden(), true);
  await h.navigate(null);
  assert.equal(h.requests[0].aborted, true);
  assert.equal(h.nativeHidden(), false);
  assert.equal(h.sourceText(), '');
  answerDeepSeek(h.requests[0], '[1] 已经离开页面。');
  await flush();
  assert.equal(h.caches().length, 0);
});

test('等待字幕时连续导航不会积累三十秒超时监听', async () => {
  const h = createHarness();
  for (let i = 0; i < 25; i++) await h.navigate(`video-${i}`);
  assert.equal([...h.clock.timers.values()].filter(timer => timer.delay === 30000).length, 1);
  await h.navigate(null);
  assert.equal([...h.clock.timers.values()].filter(timer => timer.delay === 30000).length, 0);
});

test('无效字幕保留原生字幕，下一次有效响应可以恢复', async () => {
  const h = createHarness();
  await h.capture('A', '<invalid response without captions>');
  assert.equal(h.nativeHidden(), false);
  assert.equal(h.caches().length, 0);
  await h.capture();
  assert.equal(h.targetText(), '谷歌译文。');
});

test('DeepSeek 请求使用最新模型、非思考模式和有限超时', async () => {
  const h = createHarness({engine: 'deepseek'});
  await h.capture();
  const request = h.requests[0], payload = JSON.parse(request.data);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(payload.model, 'deepseek-flash');
  assert.deepEqual(payload.thinking, {type: 'disabled'});
  assert.equal(payload.stream, false);
  assert.equal(request.timeout, 45000);
  assert.equal(h.targetText(), '深度求索译文1。');
});

test('DeepSeek 临时失败后恢复可以正常完成并缓存', async () => {
  const h = createHarness({engine: 'deepseek', respond(request, index) {
    if (index === 0) request.onload({status: 503, responseText: '{}'});
    else answerDeepSeek(request, '[1] 重试成功。');
  }});
  await h.capture();
  await h.clock.advance(500);
  assert.equal(h.requests.length, 2);
  assert.equal(h.targetText(), '重试成功。');
  assert.equal(h.caches().length, 1);
});

test('API 鉴权失败不做无效重试，也不写缓存', async () => {
  const h = createHarness({engine: 'deepseek', respond: request => request.onload({status: 401, responseText: '{}'})});
  await h.capture();
  await h.clock.advance(2000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.caches().length, 0);
});

test('没有回应的翻译请求会按超时和重试上限结束', async () => {
  const h = createHarness({engine: 'deepseek', respond: () => {}});
  await h.capture();
  await h.clock.advance(136500);
  assert.equal(h.requests.length, 3);
  assert.equal(h.caches().length, 0);
  assert.match(h.ids.get('ytdsk-debug').textContent, /未完成/);
});

test('XHR 拦截支持复用对象，不会重复处理旧 URL 的监听', async () => {
  const h = createHarness();
  const xhr = await h.xhrCapture('A', transcript(['English.']));
  await h.xhrCapture('A', transcript(['Espanol.']), 'es', xhr);
  assert.equal(h.sourceText(), 'Espanol.');
  assert.equal(h.requests.length, 2);
  assert.equal(xhr.listeners.get('load').size, 1);
});

test('视频元素稍后出现时可以继续处理已捕获字幕', async () => {
  const h = createHarness({noVideo: true});
  await h.capture();
  await h.addVideo();
  await h.clock.advance(250);
  assert.equal(h.targetText(), '谷歌译文。');
});

test('document-start 阶段捕获的字幕在 DOM 就绪后仍可读取', async () => {
  const h = createHarness({readyState: 'loading'});
  await h.capture();
  assert.equal(h.requests.length, 0);
  await h.ready();
  assert.equal(h.targetText(), '谷歌译文。');
});
