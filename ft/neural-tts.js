/**
 * neural-tts.js — 高音质英文朗读引擎（Kokoro-82M / ONNX Runtime Web）
 *
 * 为什么需要它：浏览器原生 speechSynthesis 的音色是拼接式单元合成，听感机械、
 * 语调平、停顿生硬。本模块改用 Kokoro-82M（Apache-2.0，82M 参数风格化 TTS）
 * 在浏览器本地推理，配合 Web Audio 精确调度，得到接近真人的连续语音。
 *
 * 关键设计：
 * - 按需加载：reader.js 首次点击「高音质」才动态 import 本模块，
 *   kokoro-js（约 2.1MB）与量化权重（q8，约 92MB）都在那时才开始下载。
 * - 模型来源：huggingface.co 在本机不可达，统一把 fetch 请求里的
 *   https://huggingface.co/ 改写到镜像 https://hf-mirror.com/（CORS 已实测可通）。
 * - 下载缓存：transformers.js 自动写入 Cache API（transformers-cache），
 *   本模块额外申请持久化配额，降低被浏览器回收的概率。
 * - 播放：AudioBufferSourceNode 顺序调度「片段」，播放第 i 片时提前合成
 *   第 i+1、i+2 片；播放中按进度把比例回调给上层，用于句子级高亮。
 *
 * 对外 API（均为具名导出）：
 *   load({ onProgress })      下载并初始化模型（重复调用只执行一次）
 *   play(queue, from, hooks)  queue[i] = { text, marks: [{el,start,end}] }
 *   pause() / resume() / stop()
 *   setVoice(id) / getVoice() / VOICES
 *
 * hooks: { onStart(i), onProgress(i, ratio), onEnd(), onWait(i), onError(err) }
 */

const KOKORO_VERSION = '1.2.1';
const TRANSFORMERS_VERSION = '3.5.1';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_RATE = 24000; // Kokoro 输出采样率，实际以模型返回为准

// kokoro-js 浏览器 ESM 构建；unpkg 实测可达，jsDelivr 作为备份
const MODULE_URLS = [
  'https://unpkg.com/kokoro-js@' + KOKORO_VERSION + '/dist/kokoro.web.js',
  'https://cdn.jsdelivr.net/npm/kokoro-js@' + KOKORO_VERSION + '/dist/kokoro.web.js'
];
// onnxruntime-web 的 wasm 由 transformers.js 到 @huggingface/transformers 的 dist 下取，
// 它内置默认指向 jsDelivr；这里优先用 unpkg（失败则保留内置默认）。
const WASM_BASES = [
  'https://unpkg.com/@huggingface/transformers@' + TRANSFORMERS_VERSION + '/dist/',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@' + TRANSFORMERS_VERSION + '/dist/'
];
const HF_ORIGIN = 'https://huggingface.co/';
const MIRROR_ORIGIN = 'https://hf-mirror.com/';

const PREFETCH_AHEAD = 2; // 播放第 i 片时最多提前合成到第 i+2 片
const KEEP_BEHIND = 2;    // 已播过的片段最多再保留 2 个，控制内存

// 精选英语音色（Kokoro 共 21+ 个，这里只列英式/美式常用项）
export const VOICES = [
  { id: 'bm_george', label: 'George · 英式男声' },
  { id: 'bm_lewis', label: 'Lewis · 英式男声' },
  { id: 'bm_daniel', label: 'Daniel · 英式男声' },
  { id: 'bm_fable', label: 'Fable · 英式男声' },
  { id: 'bf_emma', label: 'Emma · 英式女声' },
  { id: 'bf_isabella', label: 'Isabella · 英式女声' },
  { id: 'bf_alice', label: 'Alice · 英式女声' },
  { id: 'bf_lily', label: 'Lily · 英式女声' },
  { id: 'am_michael', label: 'Michael · 美式男声' },
  { id: 'am_onyx', label: 'Onyx · 美式男声' },
  { id: 'am_eric', label: 'Eric · 美式男声' },
  { id: 'am_liam', label: 'Liam · 美式男声' },
  { id: 'af_heart', label: 'Heart · 美式女声' },
  { id: 'af_bella', label: 'Bella · 美式女声' },
  { id: 'af_nicole', label: 'Nicole · 美式女声' },
  { id: 'af_sarah', label: 'Sarah · 美式女声' },
  { id: 'af_sky', label: 'Sky · 美式女声' },
  { id: 'af_jessica', label: 'Jessica · 美式女声' }
];

/* =============== 镜像改写 =============== */

let mirrorInstalled = false;

// transformers.js 的 remoteHost 是内部对象，无法从外部改；这里改写全局 fetch
// 前缀，把 huggingface.co 换成 hf-mirror.com。只影响该前缀的请求，随页面存活。
function installMirror() {
  if (mirrorInstalled || typeof window === 'undefined') return;
  mirrorInstalled = true;
  const orig = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url;
    if (url.indexOf(HF_ORIGIN) === 0) {
      const next = MIRROR_ORIGIN + url.slice(HF_ORIGIN.length);
      input = (typeof input === 'string') ? next : new Request(next, input);
    }
    return orig.call(window, input, init);
  };
}

/* =============== 模型加载 =============== */

let tts = null;
let loadPromise = null;
let currentVoice = 'bm_george';

function shortFile(file) {
  const s = String(file || '');
  return s.indexOf('/') === -1 ? s : s.slice(s.lastIndexOf('/') + 1);
}

function progressReporter(onProgress) {
  if (!onProgress) return undefined;
  return function (info) {
    if (!info) return;
    const name = shortFile(info.file);
    let text = '';
    if (info.status === 'progress') {
      const pct = Math.max(0, Math.min(100, Math.round(info.progress || 0)));
      // 只有模型权重占大头，单独显示百分比；其余文件显示概略状态
      text = /\.onnx$/.test(name) ? ('模型 ' + pct + '%') : '准备中…';
    } else if (info.status === 'done') {
      text = '准备中…';
    }
    if (text) onProgress({ text: text });
  };
}

async function importKokoro() {
  let lastErr = null;
  for (let i = 0; i < MODULE_URLS.length; i++) {
    try {
      // 变量化说明符：运行时从 CDN 直接加载，不做打包
      return await import(/* @vite-ignore */ MODULE_URLS[i]);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('kokoro-js 加载失败');
}

function applyWasmBase(env) {
  for (let i = 0; i < WASM_BASES.length; i++) {
    try {
      env.wasmPaths = WASM_BASES[i];
      return;
    } catch (e) {
      // ONNX 后端尚未初始化时该 setter 会抛错，留给 transformers 默认值
    }
  }
}

async function doLoad(opts) {
  const onProgress = opts && opts.onProgress;
  installMirror();

  // 尽量让下载下来的模型不被当作临时数据清掉
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) { /* 忽略 */ }

  const mod = await importKokoro();
  const KokoroTTS = mod.KokoroTTS;
  if (!KokoroTTS) throw new Error('kokoro-js 导出异常');
  if (mod.env) applyWasmBase(mod.env);

  // wasm + q8：92MB 量化权重，单线程 WASM 也能跑，兼容性最好（含 iPhone）。
  // 若日后要提速，可在此加 device:'webgpu', dtype:'fp16' 的组合（需额外下载权重）。
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: progressReporter(onProgress)
  });
  if (onProgress) onProgress({ text: '引擎就绪' });
  return tts;
}

export function load(opts) {
  if (tts) return Promise.resolve(tts);
  if (!loadPromise) {
    loadPromise = doLoad(opts).catch(function (e) {
      loadPromise = null;
      throw e;
    });
  }
  return loadPromise;
}

/* =============== 音频上下文与播放 =============== */

let ctx = null;
let gainNode = null;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window['webkitAudioContext'];
  if (!AC) throw new Error('当前浏览器不支持 Web Audio');
  ctx = new AC();
  gainNode = ctx.createGain();
  gainNode.gain.value = 1;
  gainNode.connect(ctx.destination);
  return ctx;
}

let queue = [];
let hooks = {};
let state = 'idle'; // idle | waiting | playing | paused
let index = -1;     // 当前片段下标
let offset = 0;     // 续播起点（秒）
let activeSrc = null;
let playStartTime = 0; // 换算播放进度用：src 播放起点对应的 ctx 时间
let currentDur = 0;
let rafId = 0;

const cache = new Map();   // index -> AudioBuffer
const pending = new Map(); // index -> Promise<AudioBuffer>

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function toAudioBuffer(audio, rate) {
  const buf = ctx.createBuffer(1, audio.length, rate || DEFAULT_RATE);
  buf.getChannelData(0).set(audio);
  return buf;
}

function evict(keepIndex) {
  const cut = keepIndex - KEEP_BEHIND;
  cache.forEach(function (_, k) {
    if (k < cut) cache.delete(k);
  });
}

// 合成第 i 片；同一片段并发调用共享同一个 Promise
function ensureBuffer(i) {
  if (cache.has(i)) return Promise.resolve(cache.get(i));
  if (pending.has(i)) return pending.get(i);
  const raw = (async function () {
    const out = await tts.generate(queue[i].text, { voice: currentVoice });
    const buf = toAudioBuffer(out.audio, out.sampling_rate);
    cache.set(i, buf);
    evict(i);
    return buf;
  })();
  const p = raw.finally(function () { pending.delete(i); });
  pending.set(i, p);
  return p;
}

function prefetch(i) {
  for (let k = i + 1; k <= i + PREFETCH_AHEAD && k < queue.length; k++) {
    ensureBuffer(k).catch(function () { /* 预取失败不影响当前播放 */ });
  }
}

function stopSource() {
  if (!activeSrc) return;
  const src = activeSrc;
  activeSrc = null;
  src.onended = null;
  try { src.stop(); } catch (e) { /* 已停止 */ }
}

function stopRaf() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function tick() {
  if (state !== 'playing' || !currentDur) return;
  const r = clamp((ctx.currentTime - playStartTime) / currentDur, 0, 1);
  if (hooks.onProgress) hooks.onProgress(index, r);
  rafId = requestAnimationFrame(tick);
}

function finish() {
  stopRaf();
  state = 'idle';
  index = -1;
  offset = 0;
  if (hooks.onEnd) hooks.onEnd();
}

function startSource(buf, at) {
  stopSource();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(gainNode);
  const startAt = ctx.currentTime + 0.02; // 留一点调度余量，避免起播毛刺
  src.start(startAt, at);
  activeSrc = src;
  playStartTime = startAt - at;
  currentDur = buf.duration;
  state = 'playing';
  src.onended = function () {
    if (src !== activeSrc) return; // 主动停止（暂停/切音色/换片）
    activeSrc = null;
    startItem(index + 1, 0);
  };
  if (hooks.onStart) hooks.onStart(index);
  tick();
  prefetch(index);
}

function startItem(i, at) {
  if (i >= queue.length) { finish(); return; }
  index = i;
  offset = at || 0;
  const cached = cache.get(i);
  if (cached) { startSource(cached, offset); return; }
  state = 'waiting';
  if (hooks.onWait) hooks.onWait(i);
  ensureBuffer(i).then(function (buf) {
    // 期间可能已被暂停 / 停止 / 换片，只有仍是当前片段才播放
    if (state !== 'waiting' || index !== i || !buf) return;
    const from = offset;
    startSource(buf, from);
  }).catch(function (e) {
    state = 'idle';
    if (hooks.onError) hooks.onError(e);
  });
}

export function play(list, from, h) {
  ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
  queue = list || [];
  hooks = h || {};
  stopSource();
  stopRaf();
  if (!queue.length) { finish(); return; }
  startItem(Math.max(0, from || 0), 0);
}

export function pause() {
  if (state === 'playing' && currentDur) {
    offset = clamp(ctx.currentTime - playStartTime, 0, currentDur);
  }
  stopRaf();
  stopSource();
  state = 'paused';
}

export function resume() {
  if (state !== 'paused' || index < 0) return;
  ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
  // 已合成好的片段直接续播，否则回到等待状态
  if (cache.has(index)) { startSource(cache.get(index), offset); }
  else { startItem(index, offset); }
}

export function stop() {
  stopRaf();
  stopSource();
  queue = [];
  state = 'idle';
  index = -1;
  offset = 0;
  hooks = {};
}

export function getState() {
  return state;
}

export function setVoice(id) {
  if (!id || id === currentVoice) return;
  currentVoice = id;
  cache.clear();       // 音频与音色绑定，换音色后必须重算
  pending.clear();
  if (state === 'playing' && currentDur) {
    offset = clamp(ctx.currentTime - playStartTime, 0, currentDur);
    startItem(index, offset);
  } else if (state === 'waiting') {
    startItem(index, offset);
  }
}

export function getVoice() {
  return currentVoice;
}
