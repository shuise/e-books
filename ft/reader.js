/**
 * reader.js — 英国《金融时报》原文阅读精选集 增强脚本（移动端）
 *
 * 1) 英文原文逐句朗读：底部悬浮播放条，支持「朗读 / 暂停 / 继续」，
 *    调用浏览器原生 SpeechSynthesis API。朗读时自动滚动内容到可视区，
 *    当前朗读的句子高亮为「橙色背景 + 白色文字」。
 * 2) 「下一篇」跳转阅读顺序的下一篇文章（articles_nav.js 提供顺序）。
 * 3) 课后阅读理解的「答案」链接改为弹窗直接显示答案与解析。
 *
 * 仅在检测到英文标题（含「（NNN words）」标记）的页面生效，其余页面静默无操作。
 *
 * 暂停实现说明：iOS Safari 不支持 speechSynthesis.pause()/resume()，
 * 故「暂停」采用 cancel + 记忆当前句，「继续」从当前句重新朗读，
 * 以换取各平台一致体验。
 */
(function () {
  'use strict';

  var synth = window.speechSynthesis;
  var WORDS_RE = /[（(]\s*\d+\s*words?\s*[)）]/i;
  var END_MARKER = '请根据你所读到的文章内容';

  var STATE = 'idle';            // idle | playing | paused
  var toggleBtn = null;
  var nextBtn = null;

  var playlist = [];             // [{ el, text }]：句子列表
  var cur = -1;                  // 当前句下标（最近一次开始朗读的句子）
  var runId = 0;                 // 轮次令牌：主动打断/重启时自增，用于忽略旧 utterance 迟到的回调

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  /* =============== 句子切分与播放列表 =============== */

  // 常见缩写：句号属于缩写而非句子边界
  var ABBR_RE = /(?:^|[\s(])(Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|Gen|Col|Sgt|No|Nos|vs|etc|Inc|Ltd|Co|Corp|approx|est|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.(?=\s|$)/i;

  function splitBySentences(text) {
    var out = [];
    var buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      buf += ch;
      if (ch === '.' || ch === '!' || ch === '?') {
        // 后缀：跳过空格与成对引号/括号
        var j = i + 1;
        while (j < text.length && /[\s"'”’)]/.test(text[j])) j++;
        var atEnd = j >= text.length;
        // 下一词以大写字母/数字/引号开头才算新句
        var nextCap = !atEnd && /[A-Z0-9“"']/.test(text[j]);
        if (atEnd || nextCap) {
          // 排除缩写结尾（Mr. 等）
          if (!ABBR_RE.test(buf.replace(/\s+$/, '') + ' ')) {
            if (buf.trim()) out.push(buf.trim());
            buf = '';
          }
        }
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function findEnglishTitle() {
    var nodes = document.querySelectorAll('p, h4, h3');
    for (var i = 0; i < nodes.length; i++) {
      if (WORDS_RE.test(nodes[i].textContent)) return nodes[i];
    }
    return null;
  }

  // 收集英文正文段落（标题之后、自测题之前），返回元素数组
  function englishParagraphs(titleEl) {
    var els = [];
    var el = titleEl;
    while ((el = el.nextElementSibling) != null) {
      var tag = el.tagName;
      if (tag === 'HR' || tag === 'DIV') break;
      if (tag !== 'P') continue;
      if ((el.textContent || '').indexOf(END_MARKER) !== -1) break;
      if (el.textContent.trim()) els.push(el);
    }
    return els;
  }

  // 纯文本段落：按句切分并包成内联 <span class="ft-s">，返回句子文本数组；
  // 含嵌套子元素的段落不拆分，整段视为一句。
  function splitParagraph(el) {
    if (el.getElementsByTagName('*').length > 0) {
      return { spans: null, sentences: [el.textContent.replace(/\s+/g, ' ').trim()] };
    }
    var raw = el.textContent;
    // 保留原有内部段落，重建为 span 序列
    var sents = splitBySentences(raw);
    var frag = document.createDocumentFragment();
    var spans = [];
    var keepText = raw;
    // 句子拼接应等于原文（去首尾空白），用非贪婪重建避免索引偏移
    var pos = 0;
    for (var k = 0; k < sents.length; k++) {
      var idx = keepText.indexOf(sents[k], pos);
      if (idx === -1) continue;
      if (idx > pos) frag.appendChild(document.createTextNode(keepText.slice(pos, idx)));
      var sp = document.createElement('span');
      sp.className = 'ft-s';
      sp.textContent = sents[k];
      frag.appendChild(sp);
      spans.push(sp);
      pos = idx + sents[k].length;
    }
    if (pos < keepText.length) frag.appendChild(document.createTextNode(keepText.slice(pos)));
    if (spans.length) {
      el.textContent = '';
      el.appendChild(frag);
      return { spans: spans, sentences: sents };
    }
    return { spans: null, sentences: [raw.replace(/\s+/g, ' ').trim()] };
  }

  function buildPlaylist(titleEl) {
    var list = [];
    // 标题整条
    var ttext = (titleEl.textContent || '').replace(WORDS_RE, '').trim();
    if (ttext) list.push({ el: titleEl, text: ttext });
    // 正文各段
    var paras = englishParagraphs(titleEl);
    for (var i = 0; i < paras.length; i++) {
      var r = splitParagraph(paras[i]);
      for (var k = 0; k < r.sentences.length; k++) {
        var el = (r.spans && r.spans[k]) ? r.spans[k] : paras[i];
        list.push({ el: el, text: r.sentences[k] });
      }
    }
    return list;
  }

  /* =============== 朗读控制 =============== */

  function clearHighlight() {
    var curEl = document.querySelector('.ft-cur');
    if (curEl) curEl.classList.remove('ft-cur');
  }

  function setCurrent(i) {
    clearHighlight();
    if (i < 0 || i >= playlist.length) return;
    cur = i;
    var item = playlist[i];
    if (item.el && item.el.classList) item.el.classList.add('ft-cur');
    // 自动滚动到可视区域（中段居中，避免被底部悬浮条遮挡）
    try {
      item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      item.el.scrollIntoView(true);
    }
  }

  function pickVoice(u) {
    try {
      var voices = synth.getVoices() || [];
      var picked = null, i;
      for (i = 0; i < voices.length; i++) {
        if (/^en[-_]?(US|$)/i.test(voices[i].lang)) { picked = voices[i]; break; }
      }
      if (!picked) {
        for (i = 0; i < voices.length; i++) {
          if (/^en/i.test(voices[i].lang)) { picked = voices[i]; break; }
        }
      }
      if (picked) u.voice = picked;
    } catch (e) { /* 忽略，依赖 lang 即可 */ }
  }

  // 从第 from 句开始朗读：把后续句子一次性全部排入合成队列。
  // 关键：句间不再 cancel()/逐句重启，让系统合成器在同一会话里连续吐字；
  // iOS 上这样可避免每条 utterance 反复启停音频会话导致的边界爆音与不定长停顿。
  // 每轮播放都基于一个 runId，主动打断后旧 utterance 迟到的回调会被忽略。
  function speakFrom(from) {
    if (!playlist.length || from < 0 || from >= playlist.length) return;
    runId++;
    var id = runId;
    cur = from;
    if (synth) synth.cancel();  // 仅在启动一轮时清掉旧队列
    setCurrent(cur);            // 立即高亮第一句，减少等待
    for (var i = from; i < playlist.length; i++) {
      (function (idx) {
        var u = new SpeechSynthesisUtterance(playlist[idx].text);
        u.lang = 'en-US';
        u.rate = 1.0;
        pickVoice(u);
        u.onstart = function () {
          if (id !== runId) return;   // 本 utterance 已不属于当前轮次
          setCurrent(idx);
        };
        u.onend = function () {
          if (id !== runId) return;
          if (idx === playlist.length - 1) {
            // 最后一句话读完
            clearHighlight();
            setButtonState('idle');
          }
        };
        u.onerror = function (e) {
          if (id !== runId) return;
          // canceled / interrupted 属于主动打断，交由状态机处理
          if (e && (e.error === 'canceled' || e.error === 'interrupted')) return;
          clearHighlight();
          setButtonState('idle');
        };
        synth.speak(u);
      })(i);
    }
  }

  function startSpeaking() {
    if (!synth) { window.alert('当前浏览器不支持语音朗读功能'); return; }
    if (!playlist.length) { window.alert('未找到英文原文'); return; }
    speakFrom(0);
  }

  function pauseSpeaking() {
    runId++;                    // 丢弃队列里待读句子的全部回调
    if (synth) synth.cancel();
    setButtonState('paused');
  }

  function resumeSpeaking() {
    if (!synth) return;
    setButtonState('playing');
    // 无论上一句是否已结束，统一从当前句重新朗读
    speakFrom(Math.max(cur, 0));
  }

  function stopSpeaking() {
    runId++;
    if (synth) synth.cancel();
    clearHighlight();
    setButtonState('idle');
  }

  function setButtonState(state) {
    STATE = state;
    if (!toggleBtn) return;
    toggleBtn.classList.remove('ft-playing', 'ft-paused');
    if (state === 'playing') {
      toggleBtn.textContent = '暂停';
      toggleBtn.classList.add('ft-playing');
    } else if (state === 'paused') {
      toggleBtn.textContent = '继续';
      toggleBtn.classList.add('ft-paused');
    } else {
      toggleBtn.textContent = '朗读原文';
    }
  }

  function onToggle() {
    if (!synth) { window.alert('当前浏览器不支持语音朗读功能'); return; }
    if (STATE === 'idle') {
      setButtonState('playing');
      startSpeaking();
    } else if (STATE === 'playing') {
      pauseSpeaking();
    } else if (STATE === 'paused') {
      resumeSpeaking();
    }
  }

  /* 跳转到阅读顺序的下一篇；已是最后一篇则返回目录 */
  function goNext() {
    stopSpeaking();
    var list = window.FT_ARTICLES;
    var here = (location.pathname.split('/').pop() || '').split('#')[0];
    if (!list || !list.length) { location.href = '../index.html'; return; }
    var idx = list.indexOf(here);
    var target = (idx >= 0 && idx < list.length - 1) ? list[idx + 1] : '../index.html';
    location.href = target;
  }

  /* =============== 答案弹窗 =============== */

  function buildModal() {
    var modal = document.createElement('div');
    modal.id = 'ft-modal';
    modal.innerHTML =
      '<div id="ft-card">' +
      '<span id="ft-close">&times;</span>' +
      '<div id="ft-body"></div>' +
      '</div>';
    return modal;
  }

  function openModal(html) {
    var bodyEl = document.querySelector('#ft-body');
    bodyEl.innerHTML = html;
    document.querySelector('#ft-modal').classList.add('show');
  }
  function closeModal() { document.querySelector('#ft-modal').classList.remove('show'); }

  function showAnswer(n) {
    var anchor = document.getElementById('lnkback_' + n);
    if (!anchor) { window.alert('未找到该题答案'); return; }
    var box = anchor.closest('.kt') || anchor.parentNode;
    var clone = box.cloneNode(true);
    var as = clone.querySelectorAll('a');
    for (var i = 0; i < as.length; i++) {
      as[i].removeAttribute('href');
      as[i].style.color = '#888';
      as[i].style.textDecoration = 'none';
    }
    openModal(clone.innerHTML);
  }

  /* =============== 悬浮条 =============== */

  function buildBar(titleText) {
    var bar = document.createElement('div');
    bar.id = 'ft-bar';
    bar.innerHTML =
      '<span id="ft-bar-label">' + (titleText || '英文原文') + '</span>' +
      '<button type="button" id="ft-toggle">朗读原文</button>' +
      '<button type="button" id="ft-next">下一篇</button>';
    return bar;
  }

  /* =============== 初始化 =============== */

  ready(function () {
    // 弹窗
    var modal = buildModal();
    document.body.appendChild(modal);
    modal.querySelector('#ft-close').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    var titleEl = findEnglishTitle();
    if (titleEl) {
      document.body.classList.add('ft-reading');
      playlist = buildPlaylist(titleEl);

      var titleText = (titleEl.textContent || '').replace(WORDS_RE, '').trim().slice(0, 24);
      var bar = buildBar(titleText);
      document.body.appendChild(bar);
      toggleBtn = bar.querySelector('#ft-toggle');
      nextBtn = bar.querySelector('#ft-next');
      toggleBtn.addEventListener('click', onToggle);
      nextBtn.addEventListener('click', goNext);
      // 页面卸载时停止朗读，避免悬留
      window.addEventListener('pagehide', stopSpeaking);
    }

    // 答案前向链接 → 弹窗
    var links = document.querySelectorAll('a[href*="#lnkback_"]');
    for (var i = 0; i < links.length; i++) {
      (function (a) {
        var m = (a.getAttribute('href') || '').match(/#lnkback_(\d+)/);
        if (!m) return;
        var n = m[1];
        a.setAttribute('href', 'javascript:void(0)');
        a.style.cursor = 'pointer';
        a.addEventListener('click', function (e) {
          e.preventDefault();
          showAnswer(n);
        });
      })(links[i]);
    }
  });

  // 语音列表异步加载
  if (synth && typeof synth.onvoiceschanged !== 'undefined') {
    synth.onvoiceschanged = function () { /* 触发列表缓存 */ };
  }
})();
