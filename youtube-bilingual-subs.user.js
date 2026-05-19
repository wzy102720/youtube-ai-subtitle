// ==UserScript==
// @name         YouTube 双语字幕 (DeepSeek/Google 翻译)
// @namespace    https://github.com/wzy102720/youtube-ai-subtitle
// @version      0.9.0
// @description  拦截 YouTube 自己的字幕请求，预先翻译，按时间戳叠加双语显示
// @author       you
// @match        *://*.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
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
    model: 'deepseek-chat',
    batchSize: 12,
    batchDelayMs: 200,
    debugVisible: true,
    systemPrompt:
      '把每行带编号 [N] 的英文翻译成简体中文。要求：' +
      '1) 输出每行一条，形如 "[N] 中文"，N 与输入对应 ' +
      '2) 一条输入对应一条输出，不要合并或拆分 ' +
      '3) 保留英文专有名词、人名、品牌名 ' +
      '4) 口语化、自然 ' +
      '5) 不要任何解释、引号、前后缀。',
  };

  const getKey = () => GM_getValue(CFG.keyStore, '');
  const getEngine = () => GM_getValue(CFG.engineStore, 'deepseek');
  GM_registerMenuCommand('设置 DeepSeek API Key', () => {
    const v = prompt('输入 DeepSeek API Key（sk-...）', getKey());
    if (v !== null) { GM_setValue(CFG.keyStore, v.trim()); alert('已保存。刷新视频生效。'); }
  });
  GM_registerMenuCommand('切换引擎 (当前: ' + getEngine() + ')', () => {
    const next = getEngine() === 'deepseek' ? 'google' : 'deepseek';
    GM_setValue(CFG.engineStore, next);
    alert(`已切换到 ${next}\n刷新视频生效`);
  });
  GM_registerMenuCommand('清除当前视频缓存', () => {
    const id = videoId();
    if (id) { GM_setValue(`yt-trans-${id}`, ''); alert('已清除'); }
  });
  GM_registerMenuCommand('开关调试条', () => {
    CFG.debugVisible = !CFG.debugVisible;
    const d = document.getElementById('ytdsk-debug');
    if (d) d.style.display = CFG.debugVisible ? '' : 'none';
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const videoId = () => {
    try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; }
  };
  const gmFetch = opts => new Promise((res, rej) => {
    GM_xmlhttpRequest({ ...opts, onload: res, onerror: rej, ontimeout: rej });
  });

  // ============ 拦截 YouTube 字幕请求 ============
  const capturedTranscripts = new Map();
  const captureCallbacks = [];

  function onCapture(url, body) {
    if (!body || body.length < 50) return;
    if (!url || !url.includes('/api/timedtext')) return;
    let vid = null;
    try { vid = new URL(url, location.origin).searchParams.get('v'); } catch (e) {}
    if (!vid) vid = videoId();
    if (!vid) return;
    if (capturedTranscripts.has(vid)) return;
    capturedTranscripts.set(vid, body);
    console.log('[YT双语] 已拦截字幕', vid, body.length, '字节');
    captureCallbacks.forEach(cb => { try { cb(vid, body); } catch (e) {} });
  }

  (function installInterceptors() {
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    try {
      const origFetch = win.fetch;
      if (origFetch) {
        win.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const p = origFetch.apply(this, arguments);
          if (url && url.indexOf('/api/timedtext') !== -1) {
            p.then(r => r.clone().text()).then(body => onCapture(url, body)).catch(() => {});
          }
          return p;
        };
      }
    } catch (e) { console.warn('[YT双语] fetch 拦截失败', e); }

    try {
      const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
      if (proto) {
        const origOpen = proto.open;
        proto.open = function (method, url) {
          try {
            if (typeof url === 'string' && url.indexOf('/api/timedtext') !== -1) {
              this.addEventListener('load', () => {
                try { onCapture(url, this.responseText); } catch (e) {}
              });
            }
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };
      }
    } catch (e) { console.warn('[YT双语] XHR 拦截失败', e); }
  })();

  // ============ 启动（简单版本，回到 v0.7.0 的可靠模式） ============
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
    if (d) { d.style.color = color || '#0f0'; d.textContent = '[字幕] ' + msg; }
    console.log('[YT双语]', msg);
  }
  const dbgErr = msg => dbg(msg, '#f77');

  // ============ 翻译引擎 ============
  async function translateDeepSeekBatch(lines, key) {
    const prompt = lines.map((t, i) => `[${i + 1}] ${t}`).join('\n');
    const r = await gmFetch({
      method: 'POST',
      url: 'https://api.deepseek.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      data: JSON.stringify({
        model: CFG.model, temperature: 0.3,
        messages: [
          { role: 'system', content: CFG.systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (r.status !== 200) throw new Error(`DeepSeek HTTP ${r.status}`);
    const data = JSON.parse(r.responseText);
    const text = data.choices?.[0]?.message?.content || '';
    const out = new Array(lines.length).fill('');
    const re = /^\s*\[(\d+)\]\s*(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const i = parseInt(m[1], 10) - 1;
      if (i >= 0 && i < lines.length) out[i] = m[2];
    }
    return out;
  }

  async function translateGoogleSingle(en) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(en)}`;
    const r = await gmFetch({ method: 'GET', url, responseType: 'text' });
    if (r.status !== 200) throw new Error(`Google HTTP ${r.status}`);
    const data = JSON.parse(r.responseText);
    let zh = '';
    for (const seg of (data[0] || [])) if (Array.isArray(seg) && seg[0]) zh += seg[0];
    return zh.trim();
  }

  async function translateCues(cues, onProgress) {
    const engine = getEngine();
    const total = cues.length;
    if (engine === 'google') {
      let done = 0;
      const concurrency = 4;
      async function worker(start) {
        for (let i = start; i < total; i += concurrency) {
          try { cues[i].zh = await translateGoogleSingle(cues[i].en); }
          catch (e) { cues[i].zh = ''; }
          done++;
          if (done % 5 === 0 || done === total) onProgress?.(done, total);
        }
      }
      await Promise.all(Array.from({length: concurrency}, (_, k) => worker(k)));
    } else {
      const key = getKey();
      if (!key) throw new Error('未设置 DeepSeek Key');
      for (let i = 0; i < total; i += CFG.batchSize) {
        const batch = cues.slice(i, i + CFG.batchSize);
        const tr = await translateDeepSeekBatch(batch.map(c => c.en), key);
        for (let j = 0; j < batch.length; j++) batch[j].zh = tr[j] || '';
        onProgress?.(Math.min(i + CFG.batchSize, total), total);
        await sleep(CFG.batchDelayMs);
      }
    }
  }

  // ============ 字幕解析 ============
  // 规则：
  //   1) 只在标点处切：句末标点 ( . ! ? 。 ！ ？ ) 或逗号类 ( , ， ; ； : ： )
  //   2) 跨 event 累积，绝不在 event 边界强制切（这是 YouTube ASR 自动字幕容易把
  //      一句话切到多个 event 里的根源——例如 "I also teach around" + "50 students"）
  //   3) 兜底：单段累积超过 MAX_CHUNK_MS 强制切，防止无标点字幕一直不出
  const MAX_CHUNK_MS = 10000;

  function parseJsonEvents(j) {
    // —— 第 1 步：把所有 event 的内容展平成一个带绝对时间戳的全局序列 ——
    const allSegs = [];
    let lastEventEndMs = -1;

    for (const e of j.events || []) {
      if (!e.segs || !e.segs.length) continue;
      const segs = e.segs.filter(s => s.utf8 && s.utf8.trim());
      if (!segs.length) continue;
      const eventStart = e.tStartMs || 0;
      const eventDur = e.dDurationMs || 2000;
      const eventEnd = eventStart + eventDur;

      // 跳过完全嵌套在前一个 event 里的（ASR 滚动字幕的重复）
      if (eventEnd <= lastEventEndMs) continue;
      lastEventEndMs = eventEnd;

      const hasOffsets = segs.some(s => (s.tOffsetMs || 0) > 0);

      if (!hasOffsets) {
        // 没有词级时间戳：把整段文本按标点先切一遍，按字符比例分配时间
        const full = segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (!full) continue;

        // 逐字符扫描，遇到标点就把累积内容作为一段（包含标点）
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
        if (parts.length === 0) parts.push(full);

        const totalLen = parts.reduce((a, s) => a + s.length, 0) || 1;
        let cur = 0;
        for (const p of parts) {
          const ms = eventDur * (p.length / totalLen);
          allSegs.push({
            startMs: eventStart + cur,
            endMs: eventStart + cur + ms,
            text: p,
          });
          cur += ms;
        }
      } else {
        // 有词级时间戳：保留每个 seg 作为一个片段，时间用相邻 seg 的 offset 推算
        for (let i = 0; i < segs.length; i++) {
          const startOff = segs[i].tOffsetMs || 0;
          const endOff = i + 1 < segs.length ? (segs[i + 1].tOffsetMs || 0) : eventDur;
          allSegs.push({
            startMs: eventStart + startOff,
            endMs: eventStart + endOff,
            text: segs[i].utf8 || '',
          });
        }
      }
    }

    // —— 第 2 步：在全局序列上累积切割。只在标点处切；兜底 MAX_CHUNK_MS ——
    const out = [];
    let buf = [];
    let bufStartMs = 0;

    const flush = (endMs) => {
      if (!buf.length) return;
      const text = buf.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text) {
        out.push({
          start: bufStartMs / 1000,
          end: endMs / 1000,
          en: text,
          zh: '',
        });
      }
      buf = [];
    };

    for (let i = 0; i < allSegs.length; i++) {
      const s = allSegs[i];
      if (buf.length === 0) bufStartMs = s.startMs;
      buf.push(s);

      const endsPunct = /[.!?。！？,，;；:：]\s*$/.test(s.text);
      const chunkMs = s.endMs - bufStartMs;

      if (endsPunct || chunkMs > MAX_CHUNK_MS) {
        flush(s.endMs);
      }
    }
    // 最后剩下的也输出
    if (buf.length) flush(buf[buf.length - 1].endMs);

    out.sort((a, b) => a.start - b.start);
    return out;
  }

  function parseXmlEvents(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const out = [];
    let nodes = doc.querySelectorAll('p');
    let isSrv3 = nodes.length > 0;
    if (!isSrv3) nodes = doc.querySelectorAll('text');
    for (const el of nodes) {
      const tAttr = el.getAttribute('t') || el.getAttribute('start') || '0';
      const dAttr = el.getAttribute('d') || el.getAttribute('dur') || '2000';
      const t = parseFloat(tAttr);
      const d = parseFloat(dAttr);
      const start = isSrv3 ? t / 1000 : t;
      const end = isSrv3 ? (t + d) / 1000 : (t + d);
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      out.push({ start, end, en: txt, zh: '' });
    }
    return out;
  }

  function parseBody(body) {
    const t = body.trim();
    if (t[0] === '{') return parseJsonEvents(JSON.parse(t));
    if (t[0] === '<') return parseXmlEvents(t);
    return [];
  }

  // ============ 渲染 ============
  let visible = true;
  let overlay, zhEl, enEl, videoEl;
  let cues = [], lastIdx = -1, rafId = null;

  function injectStyle() {
    if (document.getElementById('ytdsk-style')) return;
    const s = document.createElement('style');
    s.id = 'ytdsk-style';
    s.textContent = `
      #ytdsk-overlay {
        left: 0; right: 0; bottom: 12%;
        text-align: center; pointer-events: none; z-index: 2147483646;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        padding: 0 4%;
      }
      #ytdsk-zh {
        font-size: 16px; font-weight: 700; color: #fff; line-height: 1.3;
        text-shadow: 0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000;
      }
      #ytdsk-en {
        font-size: 10px; color: rgba(255,255,255,0.92); line-height: 1.25;
        margin-top: 2px; font-weight: 500;
        text-shadow: 0 0 4px #000, 0 0 6px #000, 1px 1px 2px #000;
      }
      .ytp-caption-window-container, .caption-window,
      .player-timedtext, .captions-text {
        visibility: hidden !important;
      }
      @media (max-width: 900px) {
        #ytdsk-zh { font-size: 12px; }
        #ytdsk-en { font-size: 9px; }
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
    if (overlay && overlay.parentElement === target) return;
    overlay?.remove();
    overlay = document.createElement('div');
    overlay.id = 'ytdsk-overlay';
    const _zh = document.createElement('div'); _zh.id = 'ytdsk-zh';
    const _en = document.createElement('div'); _en.id = 'ytdsk-en';
    overlay.appendChild(_zh);
    overlay.appendChild(_en);
    if (host) {
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      overlay.style.position = 'absolute';
      host.appendChild(overlay);
    } else {
      overlay.style.position = 'fixed';
      document.body.appendChild(overlay);
    }
    zhEl = _zh; enEl = _en;
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!videoEl || !cues.length || !visible) return;
    const t = videoEl.currentTime;
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].end < t) lo = mid + 1;
      else if (cues[mid].start > t) hi = mid - 1;
      else { idx = mid; break; }
    }
    if (idx === lastIdx) return;
    lastIdx = idx;
    if (idx === -1) { zhEl.textContent = ''; enEl.textContent = ''; }
    else { zhEl.textContent = cues[idx].zh || ''; enEl.textContent = cues[idx].en || ''; }
  }
  function startTick() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  // ============ 主流程 ============
  let curId = null, processing = false;

  async function processVideo(id) {
    if (processing) return;
    if (id === curId) return;
    processing = true;
    try {
      curId = id;
      cues = []; lastIdx = -1; videoEl = null;
      dbg('启动，视频 ' + id);

      for (let i = 0; i < 80 && !videoEl; i++) {
        videoEl = findMainVideo();
        if (!videoEl) await sleep(250);
      }
      if (!videoEl) { dbgErr('未找到视频元素'); return; }

      injectStyle();
      ensureOverlay();

      const cacheKey = `yt-trans-${id}`;
      const cached = GM_getValue(cacheKey, '');
      if (cached) {
        try {
          cues = JSON.parse(cached);
          dbg(`命中缓存 ${cues.length} 条 ✓`);
          startTick();
          return;
        } catch (_) {}
      }

      dbg('请打开 CC 按钮，等待拦截字幕…');
      const body = await waitForCapture(id);
      if (!body) { dbgErr('30 秒内未拦截到字幕'); return; }
      dbg(`已拦截 ${body.length} 字节，解析中…`);

      cues = parseBody(body);
      if (!cues.length) { dbgErr('解析后字幕为空'); return; }
      dbg(`解析 ${cues.length} 条，先显示英文`);
      startTick();

      dbg(`开始翻译 (引擎: ${getEngine()})`);
      try {
        await translateCues(cues, (d, t) => dbg(`翻译中 ${d}/${t}`));
        GM_setValue(cacheKey, JSON.stringify(cues));
        dbg('翻译完成 ✓');
        setTimeout(() => {
          const d = document.getElementById('ytdsk-debug');
          if (d) d.style.opacity = '0.3';
        }, 3000);
      } catch (err) {
        dbgErr('翻译失败：' + (err.message || err));
      }
    } catch (err) {
      dbgErr('脚本异常：' + (err.message || err));
      console.error('[YT双语]', err);
    } finally {
      processing = false;
    }
  }

  function waitForCapture(id) {
    return new Promise(resolve => {
      if (capturedTranscripts.has(id)) { resolve(capturedTranscripts.get(id)); return; }
      let resolved = false;
      const cb = (vid, body) => {
        if (vid === id && !resolved) { resolved = true; resolve(body); }
      };
      captureCallbacks.push(cb);
      setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 30000);
    });
  }

  let lastVid = null;
  setInterval(() => {
    const id = videoId();
    if (id && id !== lastVid) {
      lastVid = id;
      curId = null;
      setTimeout(() => processVideo(id), 600);
    }
  }, 1000);
  setTimeout(() => { lastVid = videoId(); if (lastVid) processVideo(lastVid); }, 1500);

  } // end main()
})();
