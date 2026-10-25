const test = require('node:test');
const assert = require('node:assert/strict');
const {createHarness, transcript, answerDeepSeek, deepSeekInput, flush} = require('./helpers/userscript-harness.cjs');

const asr = {kind: 'asr'};
const input = deepSeekInput;
const savedCues = h => JSON.parse(h.caches().at(-1)[1]).cues;
function respondAll(request) {
  answerDeepSeek(request, input(request).split('\n').map((line, i) =>
    `[${i + 1}] ${line.replace(/^\[\d+\] /, '')}的译文`).join('\n'));
}

test('自动英语字幕跨事件的逗号、冒号和分号不会把一句话拆开翻译', async () => {
  const h = createHarness({engine: 'deepseek'});
  const parts = ['When you open the app,', 'you can do this:', 'search your notes;', 'then ask a question.'];
  await h.capture('A', transcript(parts, {starts: [0, 2000, 4000, 6000], durations: [2000, 2000, 2000, 2000]}), 'en', asr);
  assert.equal(input(h.requests[0]), `[1] ${parts.join(' ')}`);
  assert.deepEqual(savedCues(h).map(c => [c.start, c.end]), [[0, 8]]);
});

test('一句超过十秒的 ASR 仍完整翻译，句末之后另起一句', async () => {
  const h = createHarness({engine: 'deepseek'});
  const parts = ['This searchable collection of your notes', 'helps the model find the information', 'before it answers your question.', 'Now try it.'];
  await h.capture('A', transcript(parts, {starts: [0, 6000, 12000, 16000], durations: [6000, 6000, 4000, 2000]}), 'en-US', asr);
  assert.equal(input(h.requests[0]), `[1] ${parts.slice(0, 3).join(' ')}\n[2] Now try it.`);
  assert.deepEqual(savedCues(h).map(c => [c.start, c.end]), [[0, 16], [16, 18]]);
  await h.frame(13);
  assert.equal(h.sourceText(), parts.slice(0, 3).join(' '));
  await h.frame(17);
  assert.equal(h.sourceText(), 'Now try it.');
});

test('词级 ASR 保留句子边界时间，缩写、小数和引号不会误断句', async () => {
  const h = createHarness({engine: 'deepseek'});
  const words = ['Dr.', 'Smith', 'uses', '3.14', 'in', 'the', 'U.S.', 'lab,', 'and', 'says', '“it', 'works.”', 'Next', 'test.'];
  const body = JSON.stringify({events: [{tStartMs: 0, dDurationMs: 7000,
    segs: words.map((text, i) => ({utf8: (i ? ' ' : '') + text, tOffsetMs: i * 500}))}]});
  await h.capture('A', body, 'en', asr);
  assert.equal(input(h.requests[0]), '[1] Dr. Smith uses 3.14 in the U.S. lab, and says “it works.”\n[2] Next test.');
  assert.deepEqual(savedCues(h).map(c => [c.start, c.end]), [[0, 6], [6, 7]]);
});

test('同一 ASR 事件中的多个完整句子仍分别显示', async () => {
  const h = createHarness({engine: 'deepseek'});
  await h.capture('A', transcript(['Open it. Can you see it? Yes!']), 'en', asr);
  assert.equal(input(h.requests[0]), '[1] Open it.\n[2] Can you see it?\n[3] Yes!');
  const cues = savedCues(h);
  assert.equal(cues[0].start, 0);
  assert.equal(cues.at(-1).end, 5);
  assert.ok(cues.every((c, i) => !i || c.start >= cues[i - 1].end));
});

test('ASR 显示时段重叠时仍保持原文词序，不交错两个事件的单词', async () => {
  const h = createHarness({engine: 'deepseek'});
  await h.capture('A', transcript(['The quick brown', 'fox jumps over the lazy dog.'], {starts: [0, 3000], durations: [6000, 6000]}), 'en', asr);
  assert.equal(input(h.requests[0]), '[1] The quick brown fox jumps over the lazy dog.');
});

test('ASR 滚动追加与重发不重复翻译半句', async () => {
  const h = createHarness({engine: 'deepseek'});
  const body = JSON.stringify({events: [
    {tStartMs: 0, dDurationMs: 2000, segs: [{utf8: 'When it starts,'}]},
    {tStartMs: 2000, dDurationMs: 4000, aAppend: 1, segs: [{utf8: 'wait for the answer.'}]},
    {tStartMs: 3000, dDurationMs: 3000, segs: [{utf8: 'wait for the answer.'}]},
  ]});
  await h.capture('A', body, 'en', asr);
  assert.equal(input(h.requests[0]), '[1] When it starts, wait for the answer.');
  assert.deepEqual(savedCues(h).map(c => [c.start, c.end]), [[0, 6]]);
});

test('英文人工字幕同样按句合并，Google 收到完整句子', async () => {
  const h = createHarness();
  await h.capture('A', transcript(['If you have a question,', 'ask the assistant.']), 'en');
  assert.equal(h.requests.length, 1);
  assert.equal(new URL(h.requests[0].url).searchParams.get('q'), 'If you have a question, ask the assistant.');
});

test('完整句子不会被 DeepSeek 的十二条批次边界拆开', async () => {
  const h = createHarness({engine: 'deepseek'});
  const parts = [...Array.from({length: 11}, (_, i) => `Sentence ${i + 1}.`), 'If the model searches first,', 'it can answer correctly.', 'Last sentence.'];
  const starts = parts.map((_, i) => i * 2000);
  await h.capture('A', transcript(parts, {starts, durations: parts.map(() => 2000)}), 'en', asr);
  assert.match(input(h.requests[0]), /\[12\] If the model searches first, it can answer correctly\.$/);
  await h.clock.advance(200);
  assert.equal(input(h.requests[1]), '[1] Last sentence.');
});

test('没有标点的长语流有长度上限，拆分处提供相邻原文上下文', async () => {
  const h = createHarness({engine: 'deepseek'});
  const words = Array.from({length: 100}, (_, i) => `word${i}`);
  const body = JSON.stringify({events: [{tStartMs: 0, dDurationMs: 50000,
    segs: words.map((text, i) => ({utf8: (i ? ' ' : '') + text, tOffsetMs: i * 500}))}]});
  await h.capture('A', body, 'en', asr);
  const cues = savedCues(h);
  assert.ok(cues.length > 1);
  assert.equal(cues.map(c => c.src).join(' '), words.join(' '));
  assert.ok(cues.every(c => c.end - c.start <= 20 && c.src.length <= 280));
  const payload = JSON.parse(h.requests[0].data);
  assert.match(payload.messages[0].content, /context/i);
  assert.equal(payload.messages.length, 2);
  assert.ok(payload.messages[1].content.includes(cues[1].src));
});

test('长句被迫拆分时优先使用分句边界', async () => {
  const h = createHarness({engine: 'deepseek'});
  const parts = ['we first collect the sources,', 'then we search the relevant notes,', 'because the answer depends on those notes'];
  await h.capture('A', transcript(parts, {starts: [0, 7000, 14000], durations: [7000, 7000, 9000]}), 'en', asr);
  const cues = savedCues(h);
  assert.equal(cues[0].src, parts.slice(0, 2).join(' '));
  assert.equal(cues[1].src, parts[2]);
  assert.deepEqual(cues.map(c => [c.start, c.end]), [[0, 14], [14, 23]]);
});

test('跨长静音不合并，静音中不显示后一句', async () => {
  const h = createHarness({engine: 'deepseek'});
  await h.capture('A', transcript(['When you open it,', 'another scene begins.'], {starts: [0, 30000], durations: [2000, 2000]}), 'en', asr);
  assert.equal(input(h.requests[0]), '[1] When you open it,\n[2] another scene begins.');
  await h.frame(15);
  assert.equal(h.sourceText(), '');
  assert.equal(h.targetText(), '');
});

test('漏行重试仍携带已经成功的相邻句子，仅翻译缺失行', async () => {
  const h = createHarness({engine: 'deepseek', respond(request, i) {
    if (!i) answerDeepSeek(request, '[1] 第一句译文。');
    else answerDeepSeek(request, '[1] 第二句译文。');
  }});
  await h.capture('A', transcript(['First sentence.', 'It follows that sentence.']), 'en', asr);
  await h.clock.advance(500);
  assert.equal(input(h.requests[1]), '[1] It follows that sentence.');
  assert.ok(JSON.parse(h.requests[1].data).messages[1].content.includes('First sentence.'));
  assert.deepEqual(savedCues(h).map(c => c.tgt), ['第一句译文。', '第二句译文。']);
});

test('手机后台恢复后仍按合并后的完整句子续译', async () => {
  const h = createHarness({origin: 'https://m.youtube.com', engine: 'deepseek', respond: () => {}});
  await h.capture('A', transcript(['When it returns,', 'translation should continue.']), 'en', asr);
  await h.setHidden(true);
  assert.equal(h.requests[0].aborted, true);
  await h.setHidden(false);
  assert.equal(input(h.requests[1]), '[1] When it returns, translation should continue.');
  respondAll(h.requests[1]); await flush();
  assert.equal(savedCues(h).length, 1);
});

// 构造 0.11.2 已存的缓存：正文身份保持不变，分句算法升级后不能复用被拆散的半句。
function legacyStorage(h, legacyCues, complete) {
  const current = JSON.parse((h.caches()[0] || h.progress()[0])[1]);
  const identity = current.identity.slice(0, 4);
  const prefix = complete ? 'yt-trans' : 'yt-progress';
  const key = `${prefix}-A-v3-${encodeURIComponent(JSON.stringify(identity))}`;
  return [[key, JSON.stringify({...current, v: 3, identity, complete, cues: legacyCues})]];
}

for (const complete of [true, false]) {
  test(`升级时旧${complete ? '完整缓存' : '未完成进度'}中的半句重新合并翻译，保留未变的完整句`, async () => {
    const body = transcript(['When you open it,', 'you see your notes.', 'This sentence is unchanged.'], {starts: [0, 2000, 4000], durations: [2000, 2000, 2000]});
    const initial = createHarness({engine: 'deepseek'});
    await initial.capture('A', body, 'en', asr);
    const legacy = [
      {start: 0, end: 2, src: 'When you open it,', tgt: '旧半句一'},
      {start: 2, end: 4, src: 'you see your notes.', tgt: complete ? '旧半句二' : ''},
      {start: 4, end: 6, src: 'This sentence is unchanged.', tgt: '保留的完整译文'},
    ];
    const updated = createHarness({engine: 'deepseek', storage: legacyStorage(initial, legacy, complete)});
    await updated.capture('A', body, 'en', asr);
    assert.equal(updated.requests.length, 1);
    assert.equal(input(updated.requests[0]), '[1] When you open it, you see your notes.');
    const migrated = savedCues(updated);
    assert.equal(migrated.length, 2);
    assert.equal(migrated[1].tgt, '保留的完整译文');
    const reloaded = createHarness({engine: 'deepseek', storage: [...updated.storage]});
    await reloaded.capture('A', body, 'en', asr);
    assert.equal(reloaded.requests.length, 0);
  });
}

test('新分句进度重载后仅翻译剩余句子', async () => {
  const body = transcript(['If it is ready,', 'open it.', 'Then continue.'], {starts: [0, 2000, 4000], durations: [2000, 2000, 2000]});
  const h = createHarness({engine: 'deepseek', respond: request => answerDeepSeek(request, '[1] 第一句完整译文。')});
  await h.capture('A', body, 'en', asr);
  const reloaded = createHarness({engine: 'deepseek', storage: [...h.storage]});
  await reloaded.capture('A', body, 'en', asr);
  assert.equal(input(reloaded.requests[0]), '[1] Then continue.');
  assert.equal(savedCues(reloaded)[0].tgt, '第一句完整译文。');
});

test('旧版完整句子的缓存迁移不发起额外翻译请求', async () => {
  const body = transcript(['First sentence.', 'Second sentence.']);
  const h = createHarness({engine: 'deepseek'});
  await h.capture('A', body, 'en', asr);
  const previous = savedCues(h);
  const updated = createHarness({engine: 'deepseek', storage: legacyStorage(h, previous, true)});
  await updated.capture('A', body, 'en', asr);
  assert.equal(updated.requests.length, 0);
  assert.deepEqual(savedCues(updated), previous);
});

for (const srv3 of [true, false]) {
  test(`${srv3 ? 'SRV3' : '旧格式'} XML 英语字幕使用相同的整句规则`, async () => {
    const h = createHarness({engine: 'deepseek'});
    const tag = srv3 ? 'p' : 'text';
    const attrs = srv3 ? [{t: '0', d: '2000'}, {t: '2000', d: '2000'}]
      : [{start: '0', dur: '2'}, {start: '2', dur: '2'}];
    const parts = ['If it is ready,', 'you can open it.'];
    const body = `<transcript>${parts.map((text, i) => `<${tag} ${Object.entries(attrs[i]).map(([k, v]) => `${k}="${v}"`).join(' ')}>${text}</${tag}>`).join('')}</transcript>`;
    // DOMParser 由浏览器提供；这里提供固定 XML 的 DOM，验证实际脚本如何使用其文本和时间。
    h.context.DOMParser = class {
      parseFromString(xml, type) {
        assert.equal(xml, body); assert.equal(type, 'text/xml');
        return {querySelectorAll: selector => selector === tag ? parts.map((text, i) => ({
          textContent: text, getAttribute: name => attrs[i][name] ?? null,
        })) : []};
      }
    };
    await h.capture('A', body, 'en', {...asr, fmt: srv3 ? 'srv3' : 'srv1'});
    assert.equal(input(h.requests[0]), '[1] If it is ready, you can open it.');
    assert.deepEqual(savedCues(h).map(c => [c.start, c.end]), [[0, 4]]);
  });
}
