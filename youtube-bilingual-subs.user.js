// ==UserScript==
// @name         YouTube 双语字幕 (DeepSeek/Google 翻译)
// @namespace    https://github.com/wzy102720/youtube-ai-subtitle
// @version      0.11.0
// @description  拦截 YouTube 字幕并翻译到目标语言，按时间轴叠加双语字幕，支持 DeepSeek 和 Google 翻译
// @author       wzy102720
// @match        *://*.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      translate.googleapis.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    keyStore: 'deepseek_api_key',
    engineStore: 'translate_engine',
    localeStore: 'ui_locale',
    targetStore: 'target_lang',
    // 2026-10-17 官方更新：deepseek-flash 指向 DeepSeek-V4.1-Flash-1017。
    model: 'deepseek-flash',
    batchSize: 12,
    batchDelayMs: 200,
    requestTimeoutMs: 45000,
    maxAttempts: 3,
    retryDelayMs: 500,
    cacheVersion: 3,
    debugVisible: true,
    // 系统提示词模板：参数是目标语言的可读名（如 "简体中文 (Simplified Chinese)"）。
    // 源语言不写死——DeepSeek 完全可以自动识别输入语言。
    systemPrompt: (tgtName) =>
      `Translate each [N]-numbered line into ${tgtName}.\n` +
      `Rules:\n` +
      `1) Exactly one output per input line. Do not merge or split lines.\n` +
      `2) Output format: "[N] translated text", where N matches the input number.\n` +
      `3) Keep proper nouns, person names, and brand names in their original form.\n` +
      `4) Use natural, conversational language appropriate to the target.\n` +
      `5) Output translations only — no explanations, no quotes, no prefix or suffix.`,
  };

  // ============ 语言元数据 ============
  // 目标语言代码 → 可读名（中文+英文括注），用于菜单展示、prompt、DeepSeek 系统提示词。
  // 没列出的代码也能用（直接当作 ISO 代码传给 Google / 写到 DeepSeek prompt 里）。
  const LANGS = {
    'zh-CN': '简体中文 (Simplified Chinese)',
    'zh-TW': '繁體中文 (Traditional Chinese)',
    'en':    'English',
    'ja':    '日本語 (Japanese)',
    'ko':    '한국어 (Korean)',
    'es':    'Español (Spanish)',
    'fr':    'Français (French)',
    'de':    'Deutsch (German)',
    'ru':    'Русский (Russian)',
    'pt':    'Português (Portuguese)',
    'it':    'Italiano (Italian)',
    'ar':    'العربية (Arabic)',
    'hi':    'हिन्दी (Hindi)',
    'vi':    'Tiếng Việt (Vietnamese)',
    'th':    'ไทย (Thai)',
    'id':    'Bahasa Indonesia (Indonesian)',
  };
  const langName = (code) => LANGS[code] || code;

  // ============ i18n ============
  // UI 文案的中英双语词典。启动时按 GM_setValue 或 navigator.language 选语言；
  // 用户可通过菜单"语言 / Language"手动切换。脚本源码注释保持中文。
  const I18N = {
    zh: {
      menu_lang:       (cur) => `语言 / Language: ${cur === 'zh' ? '中文' : 'English'}`,
      menu_setKey:     '设置 DeepSeek API Key',
      menu_engine:     (cur) => `切换引擎 (当前: ${cur})`,
      menu_target:     (cur) => `目标语言 / Target: ${cur}`,
      menu_clearCache: '清除当前视频缓存',
      menu_debug:      '开关调试条',
      prompt_setKey:   '输入 DeepSeek API Key（sk-...）',
      prompt_target:
        '输入目标语言代码，例如：\n' +
        'zh-CN（简体中文） / zh-TW（繁体中文）\n' +
        'en（英语） / ja（日语） / ko（韩语）\n' +
        'es / fr / de / ru / pt / it / ar / hi / vi / th / id\n' +
        '其他 ISO 语言代码也可以直接输入。',
      alert_saved:     '已保存。刷新视频生效。',
      alert_engine:    (e) => `已切换到 ${e}\n刷新视频生效`,
      alert_lang:      (l) => `已切换到 ${l === 'zh' ? '中文' : 'English'}\n刷新页面生效`,
      alert_target:    (l) => `目标语言切换到 ${l}\n刷新页面生效`,
      alert_cleared:   '已清除当前视频的所有翻译缓存，正在重新处理。',
      dbg_prefix:      '[字幕] ',
      dbg_start:       (id) => `启动，视频 ${id}`,
      dbg_noVideo:     '未找到视频元素',
      dbg_cacheHit:    (n) => `命中缓存 ${n} 条 ✓`,
      dbg_waiting:     '请打开 CC 按钮，等待拦截字幕…',
      dbg_timeout:     '暂未拦截到字幕，保留原生字幕；开启 CC 后会自动重试',
      dbg_captured:    (n, src) => `已拦截 ${n} 字节 (源: ${src})，解析中…`,
      dbg_empty:       '解析后字幕为空',
      dbg_parsed:      (n) => `解析 ${n} 条，先显示原文`,
      dbg_translating: (e, tgt) => `开始翻译 → ${tgt} (引擎: ${e})`,
      dbg_progress:    (d, t) => `翻译中 ${d}/${t}`,
      dbg_done:        '翻译完成 ✓',
      dbg_sameLang:    (l) => `源语言与目标相同 (${l})，跳过翻译`,
      dbg_transFail:   (m) => `翻译失败：${m}`,
      dbg_scriptErr:   (m) => `脚本异常：${m}`,
      err_noKey:       '未设置 DeepSeek Key',
      err_incomplete:  '翻译结果不完整，未保存缓存；请清除当前视频缓存重试',
    },
    en: {
      menu_lang:       (cur) => `Language / 语言: ${cur === 'zh' ? '中文' : 'English'}`,
      menu_setKey:     'Set DeepSeek API Key',
      menu_engine:     (cur) => `Switch engine (current: ${cur})`,
      menu_target:     (cur) => `Target language / 目标: ${cur}`,
      menu_clearCache: 'Clear cache for current video',
      menu_debug:      'Toggle debug banner',
      prompt_setKey:   'Enter DeepSeek API Key (sk-...)',
      prompt_target:
        'Enter target language code, for example:\n' +
        'zh-CN (Simplified Chinese) / zh-TW (Traditional)\n' +
        'en (English) / ja (Japanese) / ko (Korean)\n' +
        'es / fr / de / ru / pt / it / ar / hi / vi / th / id\n' +
        'Other ISO language codes also accepted.',
      alert_saved:     'Saved. Reload the video to take effect.',
      alert_engine:    (e) => `Switched to ${e}\nReload the video to take effect.`,
      alert_lang:      (l) => `Switched to ${l === 'zh' ? '中文' : 'English'}\nReload the page to take effect.`,
      alert_target:    (l) => `Target language set to ${l}\nReload the page to take effect.`,
      alert_cleared:   'All translation caches for this video cleared. Retrying now.',
      dbg_prefix:      '[Subs] ',
      dbg_start:       (id) => `Starting, video ${id}`,
      dbg_noVideo:     'Video element not found',
      dbg_cacheHit:    (n) => `Cache hit: ${n} cues ✓`,
      dbg_waiting:     'Please enable CC button, waiting for captions…',
      dbg_timeout:     'Waiting for captions; native captions remain available. Enable CC to retry automatically.',
      dbg_captured:    (n, src) => `Captured ${n} bytes (source: ${src}), parsing…`,
      dbg_empty:       'Parsed result empty',
      dbg_parsed:      (n) => `Parsed ${n} cues, showing source first`,
      dbg_translating: (e, tgt) => `Translating → ${tgt} (engine: ${e})`,
      dbg_progress:    (d, t) => `Translating ${d}/${t}`,
      dbg_done:        'Translation done ✓',
      dbg_sameLang:    (l) => `Source matches target (${l}), skipping translation`,
      dbg_transFail:   (m) => `Translation failed: ${m}`,
      dbg_scriptErr:   (m) => `Script error: ${m}`,
      err_noKey:       'DeepSeek API key not set',
      err_incomplete:  'Incomplete translation; not cached. Clear this video\'s cache to retry.',
    },
  };
  function detectLocale() {
    const saved = GM_getValue(CFG.localeStore, '');
    if (saved === 'zh' || saved === 'en') return saved;
    return (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  const LOCALE = detectLocale();
  const T = I18N[LOCALE] || I18N.en;

  function detectTarget() {
    const saved = GM_getValue(CFG.targetStore, '');
    if (saved) return saved;
    // 默认跟 UI 语言走：中文 UI 译到 zh-CN，英文 UI 译到 en
    return LOCALE === 'zh' ? 'zh-CN' : 'en';
  }
  const TARGET = detectTarget();

  const getKey = () => GM_getValue(CFG.keyStore, '');
  const getEngine = () => GM_getValue(CFG.engineStore, 'deepseek');
  let refreshCurrentVideo = () => {};

  GM_registerMenuCommand(T.menu_lang(LOCALE), () => {
    const next = LOCALE === 'zh' ? 'en' : 'zh';
    GM_setValue(CFG.localeStore, next);
    alert(T.alert_lang(next));
  });
  GM_registerMenuCommand(T.menu_setKey, () => {
    const v = prompt(T.prompt_setKey, getKey());
    if (v !== null) { GM_setValue(CFG.keyStore, v.trim()); alert(T.alert_saved); }
  });
  GM_registerMenuCommand(T.menu_engine(getEngine()), () => {
    const next = getEngine() === 'deepseek' ? 'google' : 'deepseek';
    GM_setValue(CFG.engineStore, next);
    alert(T.alert_engine(next));
  });
  GM_registerMenuCommand(T.menu_target(TARGET), () => {
    const v = prompt(T.prompt_target, TARGET);
    if (v !== null && v.trim()) {
      const code = v.trim();
      GM_setValue(CFG.targetStore, code);
      alert(T.alert_target(langName(code)));
    }
  });
  GM_registerMenuCommand(T.menu_clearCache, () => {
    const id = videoId();
    if (id) {
      // 同时清除旧格式缓存和所有引擎、模型、目标语言、字幕轨道的缓存。
      const prefix = `yt-trans-${id}-`;
      for (const key of GM_listValues()) if (key.startsWith(prefix)) GM_deleteValue(key);
      refreshCurrentVideo();
      alert(T.alert_cleared);
    }
  });
  GM_registerMenuCommand(T.menu_debug, () => {
    CFG.debugVisible = !CFG.debugVisible;
    const d = document.getElementById('ytdsk-debug');
    if (d) d.style.display = CFG.debugVisible ? '' : 'none';
  });

  function abortError() {
    const error = new Error('Task cancelled');
    error.name = 'AbortError';
    return error;
  }
  function checkSignal(signal) {
    if (signal?.aborted) throw abortError();
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  const videoId = () => {
    try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; }
  };
  function requestError(message, retryable = true) {
    const error = new Error(message);
    error.retryable = retryable;
    return error;
  }
  function gmFetch(opts, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      let request, settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => {
        finish(reject, abortError());
        request?.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        request = GM_xmlhttpRequest({
          ...opts, timeout: CFG.requestTimeoutMs,
          onload: response => finish(resolve, response),
          onerror: () => finish(reject, requestError('Network request failed')),
          ontimeout: () => finish(reject, requestError('Translation request timed out')),
          onabort: () => finish(reject, abortError()),
        });
      } catch (error) { finish(reject, error); }
    });
  }
  async function withRetry(operation, signal) {
    for (let attempt = 0; ; attempt++) {
      checkSignal(signal);
      try { return await operation(); }
      catch (error) {
        if (error.name === 'AbortError' || !error.retryable || attempt + 1 >= CFG.maxAttempts) throw error;
        await sleep(CFG.retryDelayMs * 2 ** attempt, signal);
      }
    }
  }
  function requireSuccess(response, engine) {
    if (response.status !== 200) {
      throw requestError(`${engine} HTTP ${response.status}`,
        response.status === 429 || response.status >= 500 || response.status === 0);
    }
  }
  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${text.length}-${(hash >>> 0).toString(16)}`;
  }
  function normalizeLanguage(code) {
    const value = (code || '').trim().replace(/_/g, '-').toLowerCase();
    if (/^zh-(hans(?:-|$)|cn$|sg$)/.test(value)) return 'zh-hans';
    if (/^zh-(hant(?:-|$)|tw$|hk$|mo$)/.test(value)) return 'zh-hant';
    return value;
  }

  // ============ 拦截 YouTube 字幕请求 ============
  // 每个视频保留最近一次字幕；轨道、语言及正文共同决定翻译和缓存身份。
  const capturedTranscripts = new Map();
  const captureCallbacks = new Set();
  let requestSequence = 0;

  function onCapture(url, body, sequence, requestVideoId) {
    if (typeof body !== 'string' || !body.trim()) return;
    if (!url || !url.includes('/api/timedtext')) return;
    let vid = null;
    let srcLang = '';
    let trackKey = '';
    try {
      const u = new URL(url, location.origin);
      vid = u.searchParams.get('v');
      srcLang = u.searchParams.get('tlang') || u.searchParams.get('lang') || '';
      trackKey = JSON.stringify(['lang', 'tlang', 'kind', 'name'].map(key => u.searchParams.get(key) || ''));
    } catch (e) {}
    if (!vid) vid = requestVideoId || videoId();
    if (!vid) return;
    const previous = capturedTranscripts.get(vid);
    const order = sequence ?? ++requestSequence;
    if (previous && previous.sequence > order) return;
    if (previous?.trackKey === trackKey && previous.body === body) {
      previous.sequence = order;
      return;
    }
    const captured = { body, srcLang, trackKey, digest: hashText(body), sequence: order };
    captured.signature = `${trackKey}:${captured.digest}`;
    capturedTranscripts.delete(vid);
    capturedTranscripts.set(vid, captured);
    while (capturedTranscripts.size > 20) capturedTranscripts.delete(capturedTranscripts.keys().next().value);
    console.log('[yt-bisubs] captured', vid, body.length, 'bytes', 'lang=' + (srcLang || '?'));
    captureCallbacks.forEach(cb => { try { cb(vid, captured); } catch (e) { console.warn('[yt-bisubs]', e); } });
  }

  (function installInterceptors() {
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    try {
      const origFetch = win.fetch;
      if (origFetch) {
        win.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
          const sequence = ++requestSequence;
          const requestVideoId = videoId();
          const p = origFetch.apply(this, arguments);
          if (url && url.indexOf('/api/timedtext') !== -1) {
            p.then(r => r.clone().text()).then(body => onCapture(url, body, sequence, requestVideoId)).catch(() => {});
          }
          return p;
        };
      }
    } catch (e) { console.warn('[yt-bisubs] fetch hook failed', e); }

    try {
      const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
      if (proto) {
        const origOpen = proto.open;
        const requests = new WeakMap();
        proto.open = function (method, url) {
          try {
            if (!requests.has(this)) {
              this.addEventListener('load', () => {
                const meta = requests.get(this);
                try { onCapture(meta.url, this.responseText, meta.sequence, meta.videoId); } catch (e) {}
              });
            }
            requests.set(this, { url: String(url), sequence: ++requestSequence, videoId: videoId() });
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };
      }
    } catch (e) { console.warn('[yt-bisubs] XHR hook failed', e); }
  })();

  // ============ 启动 ============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }

  function main() {

  // ============ 调试条 ============
  function ensureDebug() {
    if (document.getElementById('ytdsk-debug')) return;
    const d = document.createElement('div');
    d.id = 'ytdsk-debug';
    d.style.cssText = `
      position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
      max-width: 92vw; background: rgba(0,0,0,0.85); color: #0f0;
      font: 12px/1.4 monospace; padding: 6px 12px; border-radius: 6px;
      z-index: 2147483647; pointer-events: none; text-align: center;
      white-space: pre-wrap;
      ${CFG.debugVisible ? '' : 'display:none;'}
    `;
    (document.body || document.documentElement).appendChild(d);
  }
  function dbg(msg, color) {
    ensureDebug();
    const d = document.getElementById('ytdsk-debug');
    if (d) { d.style.color = color || '#0f0'; d.style.opacity = '1'; d.textContent = T.dbg_prefix + msg; }
    console.log('[yt-bisubs]', msg);
  }
  const dbgErr = msg => dbg(msg, '#f77');

  // ============ 翻译引擎 ============
  async function translateDeepSeekBatch(lines, task) {
    const prompt = lines.map((t, i) => `[${i + 1}] ${t}`).join('\n');
    const r = await gmFetch({
      method: 'POST',
      url: 'https://api.deepseek.com/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${task.key}` },
      data: JSON.stringify({
        model: task.model, temperature: 0.3, stream: false, max_tokens: 4096,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: CFG.systemPrompt(langName(task.target)) },
          { role: 'user', content: prompt },
        ],
      }),
    }, task.signal);
    requireSuccess(r, 'DeepSeek');
    let data;
    try { data = JSON.parse(r.responseText); }
    catch (_) { throw requestError(T.err_incomplete); }
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string' || choice.finish_reason !== 'stop') throw requestError(T.err_incomplete);
    const out = new Array(lines.length).fill('');
    for (const line of text.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = /^\s*\[(\d+)\][ \t]*(\S.*?)\s*$/.exec(line);
      if (!m) throw requestError(T.err_incomplete);
      const i = parseInt(m[1], 10) - 1;
      if (i < 0 || i >= lines.length || out[i]) throw requestError(T.err_incomplete);
      out[i] = m[2].trim();
    }
    if (out.some(line => !line)) throw requestError(T.err_incomplete);
    return out;
  }

  async function translateGoogleSingle(src, target, signal) {
    // sl=auto 让 Google 自动识别源语言，省得我们传错
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(src)}`;
    const r = await gmFetch({ method: 'GET', url }, signal);
    requireSuccess(r, 'Google');
    let data;
    try { data = JSON.parse(r.responseText); }
    catch (_) { throw requestError(T.err_incomplete); }
    let out = '';
    for (const seg of (Array.isArray(data?.[0]) ? data[0] : [])) {
      if (Array.isArray(seg) && typeof seg[0] === 'string') out += seg[0];
    }
    if (!out.trim()) throw requestError(T.err_incomplete);
    return out.trim();
  }

  async function translateCues(cues, task, onProgress) {
    const total = cues.length;
    if (task.engine === 'google') {
      let done = 0;
      const failures = [];
      const concurrency = 4;
      async function worker(start) {
        for (let i = start; i < total; i += concurrency) {
          checkSignal(task.signal);
          try {
            cues[i].tgt = await withRetry(() => translateGoogleSingle(cues[i].src, task.target, task.signal), task.signal);
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            failures.push(error);
          }
          done++;
          onProgress?.(done, total);
        }
      }
      await Promise.all(Array.from({length: concurrency}, (_, k) => worker(k)));
      if (failures.length) throw new Error(`${T.err_incomplete} (${failures.length}/${total}: ${failures[0].message})`);
    } else {
      if (!task.key) throw new Error(T.err_noKey);
      for (let i = 0; i < total; i += CFG.batchSize) {
        checkSignal(task.signal);
        const batch = cues.slice(i, i + CFG.batchSize);
        const tr = await withRetry(() => translateDeepSeekBatch(batch.map(c => c.src), task), task.signal);
        for (let j = 0; j < batch.length; j++) batch[j].tgt = tr[j];
        onProgress?.(Math.min(i + CFG.batchSize, total), total);
        if (i + CFG.batchSize < total) await sleep(CFG.batchDelayMs, task.signal);
      }
    }
  }

  // ============ 字幕解析 ============
  // 三阶段：
  //   Pass 1 — events → display blocks
  //     · json3 的 aAppend === 1 帧合入上一 block（ASR 滚动字幕的正确处理方式）
  //     · 每个 block 记录 { startMs, endMs, text, atoms }
  //   Pass 2 — 在 blocks 序列上去重重叠：
  //     · 完全相同 text → 合并时间
  //     · 后者以前者为前缀（rolling caption 增长）→ 用后者替换前者
  //     · 后者是前者尾部（rolling caption 重发）→ 丢弃后者
  //     · 内容真正不同（如 v0.9.0 漏句的 "lazy dog" 场景）→ 保留为独立 cue
  //   Pass 3 — blocks 展平成 atoms（优先用词级 offset，否则按标点+字符比例），
  //            再按标点累积成 cues
  // cue 字段：{ start, end, src, tgt } —— src 是原文，tgt 是翻译结果
  const MAX_CHUNK_MS = 10000;
  const HOLD_GAP_S = 1.5;

  function splitByPunctChar(full) {
    const parts = [];
    let acc = '';
    for (const ch of full) {
      acc += ch;
      if (/[.!?。！？,，;；:：]/.test(ch)) {
        const p = acc.trim();
        if (p) parts.push(p);
        acc = '';
      }
    }
    const tail = acc.trim();
    if (tail) parts.push(tail);
    return parts;
  }

  function chunkAtomsToCues(atoms) {
    const out = [];
    let buf = [];
    let bufStartMs = 0;
    const flush = (endMs) => {
      if (!buf.length) return;
      const text = buf.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text) out.push({ start: bufStartMs / 1000, end: endMs / 1000, src: text, tgt: '' });
      buf = [];
    };
    const ordered = atoms.slice().sort((a, b) => a.startMs - b.startMs);
    for (const s of ordered) {
      if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.endMs < s.startMs) continue;
      // 在加入下一段之前检查静音和长度，避免把后面的台词提前塞进上一句。
      if (buf.length) {
        const previousEnd = Math.max(...buf.map(atom => atom.endMs));
        if (s.startMs - previousEnd > HOLD_GAP_S * 1000 || s.endMs - bufStartMs > MAX_CHUNK_MS) {
          flush(previousEnd);
        }
      }
      if (buf.length === 0) bufStartMs = s.startMs;
      buf.push(s);
      const endsPunct = /[.!?。！？,，;；:：]\s*$/.test(s.text);
      const chunkMs = s.endMs - bufStartMs;
      if (endsPunct || chunkMs > MAX_CHUNK_MS) flush(s.endMs);
    }
    if (buf.length) flush(buf[buf.length - 1].endMs);
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  function dedupBlocks(blocks) {
    blocks.sort((a, b) => a.startMs - b.startMs);
    const out = [];
    for (const b of blocks) {
      if (!out.length) { out.push(b); continue; }
      const prev = out[out.length - 1];
      const overlaps = b.startMs < prev.endMs;
      if (!overlaps) { out.push(b); continue; }
      if (b.text === prev.text) {
        prev.endMs = Math.max(prev.endMs, b.endMs);
        continue;
      }
      if (b.text.length > prev.text.length && b.text.startsWith(prev.text)) {
        out[out.length - 1] = {
          startMs: prev.startMs,
          endMs: Math.max(prev.endMs, b.endMs),
          text: b.text,
          atoms: (b.atoms && b.atoms.length) ? b.atoms : prev.atoms,
        };
        continue;
      }
      if (prev.text.length > b.text.length && prev.text.endsWith(b.text)) {
        prev.endMs = Math.max(prev.endMs, b.endMs);
        continue;
      }
      out.push(b);
    }
    return out;
  }

  function blockToAtoms(b) {
    if (b.atoms && b.atoms.length > 1) {
      const out = [];
      for (let i = 0; i < b.atoms.length; i++) {
        const a = b.atoms[i];
        const next = i + 1 < b.atoms.length ? b.atoms[i + 1] : null;
        out.push({
          startMs: a.startMs,
          endMs: Math.min(a.endMs ?? b.endMs, next ? next.startMs : b.endMs),
          text: a.text,
        });
      }
      return out;
    }
    const parts = splitByPunctChar(b.text);
    const list = parts.length ? parts : [b.text];
    const totalLen = list.reduce((a, s) => a + s.length, 0) || 1;
    const dur = Math.max(b.endMs - b.startMs, 500);
    const out = [];
    let cur = 0;
    for (const p of list) {
      const ms = dur * (p.length / totalLen);
      out.push({ startMs: b.startMs + cur, endMs: b.startMs + cur + ms, text: p });
      cur += ms;
    }
    return out;
  }

  function parseJsonEvents(j) {
    const blocks = [];
    let cur = null;
    for (const e of j.events || []) {
      if (!e.segs || !e.segs.length) continue;
      const segs = e.segs.filter(s => s.utf8 && s.utf8.trim());
      if (!segs.length) continue;
      const eStart = e.tStartMs || 0;
      const eDur = e.dDurationMs || 2000;
      const eEnd = eStart + eDur;
      const text = segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const hasOffsets = segs.some(s => (s.tOffsetMs || 0) > 0);
      const newAtoms = hasOffsets
        ? segs.map(s => ({ startMs: eStart + (s.tOffsetMs || 0), endMs: eEnd, text: s.utf8 }))
        : [{ startMs: eStart, endMs: eEnd, text }];

      if (e.aAppend === 1 && cur) {
        cur.endMs = Math.max(cur.endMs, eEnd);
        cur.text = (cur.text + ' ' + text).replace(/\s+/g, ' ').trim();
        cur.atoms.push(...newAtoms);
      } else {
        if (cur) blocks.push(cur);
        cur = { startMs: eStart, endMs: eEnd, text, atoms: newAtoms };
      }
    }
    if (cur) blocks.push(cur);

    const merged = dedupBlocks(blocks);
    const atoms = [];
    for (const b of merged) atoms.push(...blockToAtoms(b));
    return chunkAtomsToCues(atoms);
  }

  function parseXmlEvents(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    let nodes = doc.querySelectorAll('p');
    const isSrv3 = nodes.length > 0;
    if (!isSrv3) nodes = doc.querySelectorAll('text');

    const blocks = [];
    for (const el of nodes) {
      const tAttr = el.getAttribute('t') || el.getAttribute('start') || '0';
      const dAttr = el.getAttribute('d') || el.getAttribute('dur') || '2000';
      const t = parseFloat(tAttr);
      const d = parseFloat(dAttr);
      const startMs = isSrv3 ? t : t * 1000;
      const dur = isSrv3 ? d : d * 1000;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      blocks.push({ startMs, endMs: startMs + dur, text, atoms: null });
    }

    const merged = dedupBlocks(blocks);
    const atoms = [];
    for (const b of merged) atoms.push(...blockToAtoms(b));
    return chunkAtomsToCues(atoms);
  }

  function parseBody(body) {
    const t = body.trim();
    if (t[0] === '{') return parseJsonEvents(JSON.parse(t));
    if (t[0] === '<') return parseXmlEvents(t);
    return [];
  }

  // ============ 渲染 ============
  // 多语言字体栈：覆盖 CJK + 拉丁 + 阿拉伯 + 印地 + 泰文
  let visible = true;
  let overlay, tgtEl, srcEl, videoEl, nativeCaptionHost;
  let cues = [], rafId = null;

  function injectStyle() {
    if (document.getElementById('ytdsk-style')) return;
    const s = document.createElement('style');
    s.id = 'ytdsk-style';
    s.textContent = `
      #ytdsk-overlay {
        left: 0; right: 0; bottom: 12%;
        text-align: center; pointer-events: none; z-index: 2147483646;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                     "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
                     "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo",
                     "Malgun Gothic", "Apple SD Gothic Neo",
                     "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR",
                     "Noto Sans Arabic", "Noto Sans Devanagari", "Noto Sans Thai",
                     sans-serif;
        padding: 0 4%;
      }
      #ytdsk-tgt {
        font-size: 16px; font-weight: 700; color: #fff; line-height: 1.3;
        text-shadow: 0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000;
      }
      #ytdsk-src {
        font-size: 10px; color: rgba(255,255,255,0.92); line-height: 1.25;
        margin-top: 2px; font-weight: 500;
        text-shadow: 0 0 4px #000, 0 0 6px #000, 1px 1px 2px #000;
      }
      .ytdsk-active .ytp-caption-window-container, .ytdsk-active .caption-window,
      .ytdsk-active .player-timedtext, .ytdsk-active .captions-text {
        visibility: hidden !important;
      }
      @media (max-width: 900px) {
        #ytdsk-tgt { font-size: 12px; }
        #ytdsk-src { font-size: 9px; }
      }
    `;
    document.head.appendChild(s);
  }

  function findMainVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    const vis = vids.filter(v => v.offsetWidth > 0 && v.offsetHeight > 0);
    if (!vis.length) return vids[0] || null;
    return vis.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
  }
  function findHostFor(video) {
    let el = video?.parentElement;
    while (el && el !== document.body) {
      if (el.offsetWidth >= video.offsetWidth - 10 &&
          el.offsetHeight >= video.offsetHeight - 10) return el;
      el = el.parentElement;
    }
    return video?.parentElement || null;
  }

  function ensureOverlay() {
    const host = videoEl ? findHostFor(videoEl) : null;
    const target = host || document.body;
    const captionHost = videoEl?.closest('.html5-video-player') || host;
    if (nativeCaptionHost !== captionHost) {
      setOverlayActive(false);
      nativeCaptionHost = captionHost;
    }
    if (overlay && overlay.parentElement === target) return;
    overlay?.remove();
    overlay = document.createElement('div');
    overlay.id = 'ytdsk-overlay';
    const _tgt = document.createElement('div'); _tgt.id = 'ytdsk-tgt';
    const _src = document.createElement('div'); _src.id = 'ytdsk-src';
    overlay.appendChild(_tgt);
    overlay.appendChild(_src);
    if (host) {
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      overlay.style.position = 'absolute';
      host.appendChild(overlay);
    } else {
      overlay.style.position = 'fixed';
      document.body.appendChild(overlay);
    }
    tgtEl = _tgt; srcEl = _src;
  }

  function setOverlayActive(active) {
    nativeCaptionHost?.classList.toggle('ytdsk-active', active);
  }
  function resetDisplay() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    setOverlayActive(false);
    nativeCaptionHost = null;
    overlay?.remove();
    overlay = tgtEl = srcEl = videoEl = null;
    cues = [];
  }
  function renderCurrentCue() {
    if (activeTask && !isCurrent(activeTask)) { resetDisplay(); return; }
    if (!tgtEl || !srcEl) return;
    if (!videoEl || !cues.length || !visible) {
      tgtEl.textContent = ''; srcEl.textContent = '';
      setOverlayActive(false);
      return;
    }
    const t = videoEl.currentTime;
    // 找到 start <= t 的最大 idx —— 即"最近开始的那条 cue"。
    // 滚动字幕 / 内容真正重叠 时这能让最新版本胜出，避免被旧版本覆盖显示。
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    let show = -1;
    if (idx !== -1) {
      const cue = cues[idx];
      const nextStart = idx + 1 < cues.length ? cues[idx + 1].start : Infinity;
      // 自然区间内显示；区间外但在 HOLD_GAP_S 内且未到下一条，延长显示跨过小间隙
      if (t <= cue.end || (t <= cue.end + HOLD_GAP_S && t < nextStart)) show = idx;
    }
    // 同一句的译文也会异步变化；逐项比较文本，暂停时同样立即更新。
    const targetText = show === -1 ? '' : cues[show].tgt || '';
    const sourceText = show === -1 ? '' : cues[show].src || '';
    if (tgtEl.textContent !== targetText) tgtEl.textContent = targetText;
    if (srcEl.textContent !== sourceText) srcEl.textContent = sourceText;
    setOverlayActive(Boolean(targetText || sourceText));
  }
  function tick() {
    rafId = requestAnimationFrame(tick);
    renderCurrentCue();
  }
  function startTick() {
    if (rafId) cancelAnimationFrame(rafId);
    renderCurrentCue();
    rafId = requestAnimationFrame(tick);
  }

  // ============ 主流程 ============
  let activeTask = null;

  function isCurrent(task) {
    return activeTask === task && !task.signal.aborted && videoId() === task.id;
  }
  function requireCurrent(task) {
    if (!isCurrent(task)) throw abortError();
  }
  function completeCues(list) {
    return Array.isArray(list) && list.length > 0 && list.every((cue, index) =>
      cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end >= cue.start &&
      typeof cue.src === 'string' && cue.src.trim() && typeof cue.tgt === 'string' && cue.tgt.trim() &&
      (index === 0 || cue.start >= list[index - 1].start));
  }
  function cacheIdentity(task, captured) {
    return [task.target, task.engine, task.model, captured.signature];
  }
  function cacheKeyFor(task, captured) {
    return `yt-trans-${task.id}-v${CFG.cacheVersion}-${encodeURIComponent(JSON.stringify(cacheIdentity(task, captured)))}`;
  }
  function readCache(task, captured) {
    try {
      const data = JSON.parse(GM_getValue(cacheKeyFor(task, captured), ''));
      if (data?.v === CFG.cacheVersion && data.complete === true &&
          data.videoId === task.id && JSON.stringify(data.identity) === JSON.stringify(cacheIdentity(task, captured)) &&
          completeCues(data.cues)) return data.cues;
    } catch (_) {}
    return null;
  }
  function writeCache(task, captured, list) {
    requireCurrent(task);
    if (!completeCues(list)) throw new Error(T.err_incomplete);
    GM_setValue(cacheKeyFor(task, captured), JSON.stringify({
      v: CFG.cacheVersion, complete: true, videoId: task.id,
      srcLang: captured.srcLang, identity: cacheIdentity(task, captured), cues: list,
    }));
  }

  async function processVideo(id, suppliedCapture = null, force = false) {
    if (!id || id !== videoId()) return;
    const capturedAtStart = suppliedCapture || capturedTranscripts.get(id);
    const engine = getEngine();
    const model = engine === 'google' ? 'google-gtx' : CFG.model;
    const signature = capturedAtStart?.signature || '';
    if (!force && activeTask?.id === id && activeTask.engine === engine && activeTask.model === model &&
        activeTask.signature === signature && !activeTask.signal.aborted &&
        !['error', 'waiting-late', 'no-video'].includes(activeTask.status)) return;

    activeTask?.controller.abort();
    const controller = new AbortController();
    const task = { id, engine, model, target: TARGET, key: getKey(), signature,
      controller, signal: controller.signal, status: 'starting' };
    activeTask = task;
    resetDisplay();
    try {
      dbg(T.dbg_start(id));
      let currentVideo = null;
      for (let i = 0; i < 80 && !currentVideo; i++) {
        requireCurrent(task);
        currentVideo = findMainVideo();
        if (!currentVideo) await sleep(250, task.signal);
      }
      requireCurrent(task);
      if (!currentVideo) { task.status = 'no-video'; dbgErr(T.dbg_noVideo); return; }
      videoEl = currentVideo;
      injectStyle();
      ensureOverlay();
      dbg(T.dbg_waiting);
      task.status = 'waiting';
      const captured = capturedAtStart || await waitForCapture(id, task.signal);
      requireCurrent(task);
      if (!captured) { task.status = 'waiting-late'; dbgErr(T.dbg_timeout); return; }
      task.signature = captured.signature;
      const { body, srcLang } = captured;
      dbg(T.dbg_captured(body.length, srcLang || '?'));
      const parsed = parseBody(body);
      if (!parsed.length) { task.status = 'error'; dbgErr(T.dbg_empty); return; }
      const cached = readCache(task, captured);
      if (cached) {
        cues = cached;
        task.status = 'complete';
        dbg(T.dbg_cacheHit(cues.length));
        startTick();
        return;
      }
      // 每个任务只修改自己的数组；旧视频的请求即使迟到，也无法修改当前画面。
      const taskCues = parsed;
      cues = taskCues;
      dbg(T.dbg_parsed(cues.length));
      startTick();
      // 仅跳过明确相同的语言；简体、繁体分别比较，不按主语言粗略合并。
      const sourceLanguage = normalizeLanguage(srcLang);
      if (sourceLanguage && sourceLanguage === normalizeLanguage(task.target)) {
        for (const cue of taskCues) cue.tgt = cue.src;
        writeCache(task, captured, taskCues);
        task.status = 'complete';
        renderCurrentCue();
        dbg(T.dbg_sameLang(srcLang || TARGET));
        return;
      }
      task.status = 'translating';
      dbg(T.dbg_translating(task.engine, langName(task.target)));
      await translateCues(taskCues, task, (done, total) => {
        if (!isCurrent(task)) return;
        renderCurrentCue();
        dbg(T.dbg_progress(done, total));
      });
      writeCache(task, captured, taskCues);
      task.status = 'complete';
      renderCurrentCue();
      dbg(T.dbg_done);
      setTimeout(() => {
        if (!isCurrent(task)) return;
        const d = document.getElementById('ytdsk-debug');
        if (d) d.style.opacity = '0.3';
      }, 3000);
    } catch (err) {
      if (err.name === 'AbortError' || !isCurrent(task)) return;
      task.status = 'error';
      dbgErr(T.dbg_transFail(err.message || err));
      console.error('[yt-bisubs]', err);
    }
  }

  function waitForCapture(id, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      if (capturedTranscripts.has(id)) { resolve(capturedTranscripts.get(id)); return; }
      let timer;
      const cleanup = () => {
        captureCallbacks.delete(cb);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const cb = (vid, captured) => { if (vid === id) { cleanup(); resolve(captured); } };
      const onAbort = () => { cleanup(); reject(abortError()); };
      captureCallbacks.add(cb);
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { cleanup(); resolve(null); }, 30000);
    });
  }

  let lastVid = null;
  // 常驻监听让超时后的字幕和同视频的新轨道都能启动新任务。
  captureCallbacks.add((id, captured) => {
    if (id !== videoId()) return;
    lastVid = id;
    void processVideo(id, captured);
  });
  refreshCurrentVideo = () => {
    const id = videoId();
    if (id) void processVideo(id, null, true);
  };
  function syncNavigation() {
    const id = videoId();
    if (id !== lastVid) {
      lastVid = id;
      if (id) void processVideo(id);
      else {
        activeTask?.controller.abort();
        activeTask = null;
        resetDisplay();
      }
    } else if (id && activeTask?.status === 'no-video' && findMainVideo()) {
      void processVideo(id, null, true);
    } else if (id && cues.length) {
      const currentVideo = findMainVideo();
      if (currentVideo && currentVideo !== videoEl) {
        videoEl = currentVideo;
        ensureOverlay();
        startTick();
      }
    }
  }
  document.addEventListener('yt-navigate-finish', syncNavigation);
  setInterval(syncNavigation, 1000);
  syncNavigation();

  } // end main()
})();
