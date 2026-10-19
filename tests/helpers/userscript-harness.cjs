const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../../youtube-bilingual-subs.user.js'), 'utf8');

async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

class Clock {
  now = 0;
  serial = 0;
  timers = new Map();
  frames = new Map();
  add(callback, delay = 0, interval = false) {
    const id = ++this.serial;
    this.timers.set(id, {callback, due: this.now + delay, delay, interval});
    return id;
  }
  async advance(ms) {
    const end = this.now + ms;
    for (let steps = 0; ; steps++) {
      assert.ok(steps < 10000, '定时器没有收敛');
      const next = [...this.timers].filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.interval) timer.due += timer.delay;
      else this.timers.delete(id);
      timer.callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
  async frame() {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(this.now);
    await flush();
  }
}

function answerDeepSeek(request, content, finishReason = 'stop') {
  request.onload({status: 200, responseText: JSON.stringify({
    choices: [{message: {content}, finish_reason: finishReason}],
  })});
}

function transcript(texts = ['Hello there.'], options = {}) {
  return JSON.stringify({events: texts.map((text, index) => ({
    tStartMs: options.starts?.[index] ?? index * 6000,
    dDurationMs: options.durations?.[index] ?? 5000,
    segs: [{utf8: text}],
  }))});
}

function createHarness(options = {}) {
  const clock = new Clock();
  const ids = new Map(), listeners = new Map(), windowListeners = new Map();
  const storage = new Map(options.storage || []);
  const defaults = {ui_locale: 'zh', target_lang: options.target ?? 'zh-CN',
    translate_engine: options.engine ?? 'google', deepseek_api_key: 'mock-test-key'};
  for (const [key, value] of Object.entries(defaults)) if (!storage.has(key)) storage.set(key, value);
  if (options.engine) storage.set('translate_engine', options.engine);
  if (options.target) storage.set('target_lang', options.target);
  const requests = [], fetchRequests = [], menus = [], logs = [], writes = [];

  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.parentElement = null;
      this.style = {}; this.textContent = ''; this.offsetWidth = 1280; this.offsetHeight = 720;
      const classes = new Set();
      this.classList = {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle(name, enabled = !classes.has(name)) {
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
      };
    }
    appendChild(child) {
      child.parentElement = this; this.children.push(child);
      if (child.id) ids.set(child.id, child);
      return child;
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this);
      if (this.id) ids.delete(this.id);
      for (const child of [...this.children]) child.remove();
      this.parentElement = null;
    }
    closest(selector) {
      for (let element = this; element; element = element.parentElement) {
        if (selector === '.html5-video-player' && element.classList.contains('html5-video-player')) return element;
      }
      return null;
    }
  }
  class XMLHttpRequest {
    listeners = new Map();
    open() {}
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }
    load(body) {
      this.responseText = body;
      this.listeners.get('load')?.forEach(callback => callback());
    }
  }
  const body = new Element('body'), head = new Element('head');
  const player = body.appendChild(new Element('player'));
  player.classList.add('html5-video-player');
  const container = player.appendChild(new Element('video-container'));
  let video = options.noVideo ? null : container.appendChild(new Element('video'));
  if (video) video.currentTime = options.currentTime ?? 1;
  const origin = options.origin || 'https://www.youtube.com';
  const location = {href: `${origin}/watch?v=${options.id || 'A'}`, origin};
  const document = {
    readyState: options.readyState || 'complete', hidden: options.hidden === true,
    visibilityState: options.hidden ? 'hidden' : 'visible', body, head, documentElement: body,
    createElement: tag => new Element(tag), getElementById: id => ids.get(id) || null,
    querySelectorAll: selector => selector === 'video' && video ? [video] : [],
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    dispatch(name, event = {}) { listeners.get(name)?.forEach(callback => callback(event)); },
  };
  const sandbox = {
    document, location, navigator: {language: options.language || 'zh-CN'}, URL, AbortController,
    addEventListener(name, callback) {
      if (!windowListeners.has(name)) windowListeners.set(name, new Set());
      windowListeners.get(name).add(callback);
    },
    XMLHttpRequest,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => { writes.push({key, value}); storage.set(key, value); },
    GM_listValues: () => [...storage.keys()], GM_deleteValue: key => storage.delete(key),
    GM_registerMenuCommand: (label, callback) => menus.push({label, callback}),
    GM_xmlhttpRequest(details) {
      const request = {...details, aborted: false};
      requests.push(request);
      let expiry;
      for (const name of ['onload', 'onerror', 'ontimeout', 'onabort']) {
        request[name] = value => { clock.timers.delete(expiry); details[name]?.(value); };
      }
      if (details.timeout) expiry = clock.add(() => request.ontimeout(), details.timeout);
      if (options.respond) options.respond(request, requests.length - 1);
      else if (request.url.includes('translate.googleapis.com')) {
        request.onload({status: 200, responseText: JSON.stringify([[['谷歌译文。', 'source']]])});
      } else {
        const input = JSON.parse(request.data).messages[1].content;
        const count = (input.match(/^\[\d+\]/gm) || []).length;
        answerDeepSeek(request, Array.from({length: count}, (_, i) => `[${i + 1}] 深度求索译文${i + 1}。`).join('\n'));
      }
      return {abort() { request.aborted = true; request.onabort(); }};
    },
    fetch(input, init) {
      return new Promise((resolve, reject) => {
        fetchRequests.push({input, init, reject,
          respond: text => resolve({clone: () => ({text: async () => text})})});
      });
    },
    setTimeout: (callback, delay) => clock.add(callback, delay),
    clearTimeout: id => clock.timers.delete(id),
    setInterval: (callback, delay) => clock.add(callback, delay, true),
    clearInterval: id => clock.timers.delete(id),
    requestAnimationFrame: callback => { const id = ++clock.serial; clock.frames.set(id, callback); return id; },
    cancelAnimationFrame: id => clock.frames.delete(id),
    getComputedStyle: element => ({position: element.style.position || 'static'}),
    alert: () => {}, prompt: () => null,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(options.source || source, context, {filename: 'youtube-bilingual-subs.user.js'});

  function beginCapture(id, language = 'en', extra = {}) {
    const url = new URL('https://www.youtube.com/api/timedtext');
    for (const [key, value] of Object.entries({v: id, lang: language, fmt: 'json3', ...extra})) url.searchParams.set(key, value);
    const promise = context.fetch(url.href);
    const request = fetchRequests.at(-1);
    return {async respond(body) { request.respond(body); await promise; await flush(); }};
  }
  return {
    storage, writes, requests, menus, logs, ids, player, context, clock, beginCapture,
    get video() { return video; },
    sourceText: () => ids.get('ytdsk-src')?.textContent || '',
    targetText: () => ids.get('ytdsk-tgt')?.textContent || '',
    nativeHidden: () => player.classList.contains('ytdsk-active'),
    caches: () => [...storage].filter(([key]) => key.startsWith('yt-trans-')),
    progress: () => [...storage].filter(([key]) => key.startsWith('yt-progress-')),
    async capture(id = options.id || 'A', body = transcript(), language = 'en', extra = {}) {
      await beginCapture(id, language, extra).respond(body);
    },
    async xhrCapture(id, body, language = 'en', xhr = new context.XMLHttpRequest()) {
      xhr.open('GET', `https://www.youtube.com/api/timedtext?v=${id}&lang=${language}`);
      xhr.load(body); await flush(); return xhr;
    },
    async navigate(id) {
      location.href = id ? `${origin}/watch?v=${id}` : `${origin}/`;
      document.dispatch('yt-navigate-finish'); await flush();
    },
    async frame(time) { if (time !== undefined) video.currentTime = time; await clock.frame(); },
    async clearCache() { menus.find(menu => menu.label === '清除当前视频缓存').callback(); await flush(); },
    async retry() { menus.find(menu => menu.label === '继续翻译未完成字幕').callback(); await flush(); },
    async setHidden(hidden, dispatch = true) {
      document.hidden = hidden; document.visibilityState = hidden ? 'hidden' : 'visible';
      if (dispatch) document.dispatch('visibilitychange');
      await flush();
    },
    async lifecycle(name, event = {}) {
      if (['pagehide', 'pageshow', 'focus'].includes(name)) windowListeners.get(name)?.forEach(callback => callback(event));
      else document.dispatch(name, event);
      await flush();
    },
    async addVideo() { video = container.appendChild(new Element('video')); video.currentTime = 1; await flush(); },
    async ready() { document.readyState = 'complete'; document.dispatch('DOMContentLoaded'); await flush(); },
  };
}

module.exports = {createHarness, transcript, answerDeepSeek, flush};
