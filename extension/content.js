/*
 * VK Tracklist Search — content script.
 *
 * Находит в текстах постов VK строки вида «04 Grum - Stay With Me» и добавляет
 * в конец каждой такой строки кнопку, открывающую поиск трека в аудио VK:
 *   https://vk.ru/audios<id>?q=<дважды URL-encoded запрос>
 */
(function () {
  'use strict';

  if (window.__vktTracklistSearchLoaded) return;
  window.__vktTracklistSearchLoaded = true;

  var DEFAULTS = (window.VKT && window.VKT.DEFAULTS) || {
    enabled: true,
    requireMedia: true,
    minTracks: 3,
    openInNewTab: true,
    queryEncoding: 'double',
    audioOwnerId: ''
  };

  var TEXT_SELECTOR = '[data-testid="post_text"], [data-testid="post-text"]';
  var POST_SELECTOR = '[data-testid="post"], [data-post-id]';
  var BTN_CLASS = 'vkt-track-search-btn';
  var BTN_ATTR = 'data-vkt-search-btn';
  var BTN_KEY = 'data-vkt-key';

  // Блочные элементы считаем границами строк: так треклист разбирается и
  // тогда, когда VK рисует строки отдельными div, а не через <br>.
  var BLOCK_TAGS = {
    DIV: 1, P: 1, LI: 1, UL: 1, OL: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, PRE: 1, TABLE: 1, TR: 1
  };

  // Признаки аудио/видео-вложения в посте. Новый VK помечает музыкальные
  // вложения testid'ами вида musicattach-*, music-track-overlay-badge и т.п.
  var MEDIA_SELECTOR = [
    'audio',
    'video',
    '[data-testid*="music"]',
    '[data-testid*="audio"]',
    '[data-testid*="video"]',
    '[class*="AudioAttachment"]',
    '[class*="VideoAttachment"]',
    '[class*="audio_attachment"]',
    '[class*="video_attachment"]'
  ].join(',');

  var ICON_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true" focusable="false">' +
    '<circle cx="6.9" cy="6.9" r="4.15" stroke="currentColor" stroke-width="1.6"></circle>' +
    '<path d="M10.1 10.1 13.9 13.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>' +
    '</svg>';

  var settings = {};
  var ownerIdFromDom = '';
  var pendingSearch = null;
  var lastHref = location.href;
  var lastRoute = location.pathname + location.search;
  var scanTimer = null;
  var navTimer = null;
  var observer = null;
  var booted = false;

  /* ------------------------------------------------------------------ */
  /* Настройки                                                           */
  /* ------------------------------------------------------------------ */

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function applySettings(values) {
    settings = Object.assign({}, DEFAULTS, values || {});
    settings.minTracks = clampInt(settings.minTracks, 1, 50, DEFAULTS.minTracks);
    settings.queryEncoding = settings.queryEncoding === 'single' ? 'single' : 'double';
    settings.audioOwnerId = String(settings.audioOwnerId || '').trim();
    if (!/^\d{1,20}$/.test(settings.audioOwnerId)) settings.audioOwnerId = '';
    settings.enabled = settings.enabled !== false;
    settings.requireMedia = settings.requireMedia !== false;
    settings.openInNewTab = settings.openInNewTab !== false;
  }

  function storageGet(area, defaults, callback) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage[area]) {
        chrome.storage[area].get(defaults, function (values) {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              callback(defaults);
              return;
            }
          } catch (e) { /* ignore */ }
          callback(values || defaults);
        });
        return;
      }
    } catch (e) { /* ignore */ }
    callback(defaults);
  }

  function storageSet(area, values) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage[area]) {
        chrome.storage[area].set(values);
      }
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Адрес поиска                                                        */
  /* ------------------------------------------------------------------ */

  function isVkHost() {
    var host = location.hostname;
    return host === 'vk.ru' || host === 'vk.com' ||
      /\.vk\.ru$/.test(host) || /\.vk\.com$/.test(host);
  }

  function searchOrigin() {
    return isVkHost() ? location.origin : 'https://vk.ru';
  }

  function setDetectedOwner(id) {
    if (!/^\d{1,20}$/.test(id) || id === ownerIdFromDom) return;
    ownerIdFromDom = id;
    storageSet('local', { detectedAudioOwnerId: id });
  }

  function refreshOwnerId() {
    // Учим ID только со страницы музыки: адрес вида /audios<ID>.
    // Ссылки в ленте могут вести на чужую музыку, поэтому их не используем.
    var m = /^\/audios\/?(\d+)/.exec(location.pathname);
    if (m) setDetectedOwner(m[1]);
  }

  function resolveOwnerId() {
    if (settings.audioOwnerId) return settings.audioOwnerId;
    var m = /^\/audios\/?(\d+)/.exec(location.pathname);
    if (m) return m[1];
    return ownerIdFromDom || '';
  }

  function encodeQuery(query) {
    var once = encodeURIComponent(query);
    // VK сам кодирует параметр поиска ещё раз, поэтому в адресе получается
    // %2520 вместо %20 (как в адресах, которые генерирует сам сайт).
    return settings.queryEncoding === 'single' ? once : encodeURIComponent(once);
  }

  function buildSearchUrl(query) {
    return searchOrigin() + '/audios' + resolveOwnerId() + '?q=' + encodeQuery(query);
  }

  // Если ID владельца ещё неизвестен, запоминаем запрос: когда вкладка
  // откроет страницу музыки, content script при необходимости повторит
  // переход уже с ID, если VK потерял параметр q при редиректе.
  function rememberPendingSearch(query) {
    if (!query) return;
    storageSet('local', {
      pendingAudioSearch: { query: query, ts: Date.now() }
    });
  }

  function handlePendingSearch(pending) {
    if (pending) pendingSearch = pending;
    if (!pendingSearch) return;

    if (!(Date.now() - Number(pendingSearch.ts) < 2 * 60 * 1000)) {
      pendingSearch = null;
      storageSet('local', { pendingAudioSearch: null });
      return;
    }

    var currentQuery = '';
    try {
      currentQuery = new URLSearchParams(location.search).get('q') || '';
    } catch (e) { /* ignore */ }

    var match = /^\/audios\/?(\d+)/.exec(location.pathname);
    if (!match) return;

    var query = String(pendingSearch.query);
    pendingSearch = null;
    storageSet('local', { pendingAudioSearch: null });

    // Если VK сохранил q при редиректе — ничего не делаем.
    if (currentQuery) return;

    location.replace(
      location.origin + '/audios' + match[1] + '?q=' + encodeQuery(query)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Разбор текста поста                                                 */
  /* ------------------------------------------------------------------ */

  function normalizeText(value) {
    return String(value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Строка вида «01 GXD & Elle Vee - Sail (Ginchy Remix)», «1. Artist - Title»,
  // «[00:12] 03 Artist – Title». Возвращает запрос без номера трека.
  var TRACK_LINE_RE = /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(\d{1,3})(?!\d)\s*[.)\]]?\s*(?:[-–—]\s+)?(.+)$/;

  function splitArtistTitle(text) {
    var split = /^(.+?)\s+[-–—]\s+(.+)$/.exec(text) ||
      /^(.+?)\s*[–—]\s*(.+)$/.exec(text);
    if (!split) return null;
    var artist = split[1].trim();
    var title = split[2].trim();
    if (!artist || !title) return null;
    if (!/\p{L}/u.test(artist)) return null;
    return { artist: artist, title: title };
  }

  function parseTrackLine(raw) {
    var text = normalizeText(raw);
    if (!text || text.length > 400) return null;

    var match = TRACK_LINE_RE.exec(text);
    if (!match) return null;

    var number = parseInt(match[1], 10);
    var rest = match[2].replace(/^[-–—]\s*/, '').trim();
    if (!rest || rest.length < 3) return null;

    // Нужен разделитель «исполнитель — название».
    var parts = splitArtistTitle(rest);
    if (!parts) return null;

    return { number: number, artist: parts.artist, title: parts.title, query: rest };
  }

  var TRACKLIST_HEADER_RE = /^(?:track\s*list|треклист|playlist|плейлист|tl)\b/i;

  function isTracklistHeader(text) {
    return text.length <= 60 && TRACKLIST_HEADER_RE.test(text);
  }

  // Ненумерованная строка треклиста: «Molac, Plecta - Zenith (Original Mix)».
  function parseLooseTrack(raw) {
    var text = normalizeText(raw);
    if (!text || text.length > 300) return null;
    if (/^https?:\/\//i.test(text)) return null;
    if (isTracklistHeader(text)) return null;
    if (!splitArtistTitle(text)) return null;
    return { query: text };
  }

  function parseTrackCandidate(raw) {
    var numbered = parseTrackLine(raw);
    if (numbered) return { query: numbered.query, numbered: true };
    var loose = parseLooseTrack(raw);
    if (loose) return { query: loose.query, numbered: false };
    return null;
  }

  /**
   * Треклист без номеров. Сначала ищем заголовок «Tracklist:» и берём строки
   * после него; если заголовка нет — самый длинный непрерывный блок строк
   * «исполнитель — название» (не короче 5 строк).
   */
  function collectUnnumberedTracks(lines) {
    for (var h = lines.length - 1; h >= 0; h--) {
      if (!isTracklistHeader(lines[h].text)) continue;

      var block = [];
      for (var i = h + 1; i < lines.length; i++) {
        var candidate = parseTrackCandidate(lines[i].text);
        if (!candidate) {
          if (block.length) break;
          continue;
        }
        block.push({
          query: candidate.query,
          anchor: lines[i].anchor,
          lastTextNode: lines[i].lastTextNode
        });
      }
      if (block.length >= settings.minTracks) return block;
    }

    var best = [];
    var current = [];

    function flushRun() {
      if (current.length > best.length) best = current.slice();
      current = [];
    }

    for (var j = 0; j < lines.length; j++) {
      var parsed = parseTrackCandidate(lines[j].text);
      if (parsed && lines[j].gapBefore) flushRun();
      if (parsed) {
        current.push({
          query: parsed.query,
          anchor: lines[j].anchor,
          lastTextNode: lines[j].lastTextNode
        });
      } else {
        flushRun();
      }
    }
    flushRun();

    if (best.length >= Math.max(settings.minTracks, 5)) return best;
    return [];
  }

  // Если <br> лежит внутри служебного div нулевой ширины (разделитель абзацев
  // в новом VK), кнопку нужно вставлять перед этим div, иначе она окажется
  // внутри блока шириной 0.
  function breakAnchor(br, container) {
    var parent = br.parentElement;
    if (parent && parent !== container && parent.tagName === 'DIV') {
      var style = parent.getAttribute('style') || '';
      var onlyBreak = !parent.textContent.trim() &&
        parent.querySelectorAll('br').length === 1 &&
        !parent.querySelector('a,img,svg');
      if (/width:\s*0(?:px)?/i.test(style) || onlyBreak) return parent;
    }
    return br;
  }

  // Для последней строки поста (после неё нет <br>) кнопку вставляем сразу
  // после последнего текстового узла строки, а не в конец контейнера, чтобы
  // она не уехала на отдельную строку после блочных обёрток.
  function endInsertionPoint(lastTextNode, container) {
    if (!lastTextNode || !lastTextNode.parentNode || !container.contains(lastTextNode)) return null;
    var parentElement = lastTextNode.parentElement;
    var link = parentElement ? parentElement.closest('a') : null;
    if (link && link !== container && container.contains(link) && link.parentNode) {
      return { parent: link.parentNode, before: link.nextSibling };
    }
    return { parent: lastTextNode.parentNode, before: lastTextNode.nextSibling };
  }

  /**
   * Разбирает содержимое поста на строки, сохраняя для каждой строки элемент,
   * перед которым можно вставить кнопку (обычно это <br>, завершающий строку).
   */
  function extractLines(container) {
    var lines = [];
    var buffer = '';
    var anchor = null;
    var lastTextNode = null;
    var gapPending = false;

    function flush(gapNext) {
      var text = normalizeText(buffer);
      if (text) {
        lines.push({
          text: text,
          anchor: anchor,
          lastTextNode: lastTextNode,
          gapBefore: gapPending
        });
        gapPending = false;
      }
      buffer = '';
      anchor = null;
      if (gapNext) gapPending = true;
    }

    function walk(parent) {
      var node = parent.firstChild;
      while (node) {
        if (node.nodeType === 3) {
          buffer += node.nodeValue || '';
          lastTextNode = node;
          node = node.nextSibling;
          continue;
        }
        if (node.nodeType !== 1) {
          node = node.nextSibling;
          continue;
        }
        if (node.hasAttribute(BTN_ATTR)) {
          node = node.nextSibling;
          continue;
        }

        var tag = node.tagName;
        if (tag === 'BR') {
          var brAnchor = breakAnchor(node, container);
          anchor = brAnchor;
          flush(brAnchor !== node);
        } else if (
          tag !== 'BUTTON' && tag !== 'SCRIPT' && tag !== 'STYLE' &&
          tag !== 'IMG' && tag !== 'SVG' && tag !== 'VIDEO' && tag !== 'AUDIO' &&
          node.getAttribute('role') !== 'button' &&
          node.getAttribute('aria-hidden') !== 'true'
        ) {
          if (BLOCK_TAGS[tag]) {
            flush(false);
            walk(node);
            flush(false);
          } else {
            walk(node);
          }
        }

        node = node.nextSibling;
      }
    }

    walk(container);
    flush(false);
    return lines;
  }

  /* ------------------------------------------------------------------ */
  /* Кнопки                                                              */
  /* ------------------------------------------------------------------ */

  function stopPropagation(event) {
    event.stopPropagation();
  }

  function onButtonClick(event) {
    event.stopPropagation();
    var query = this.getAttribute('data-vkt-query') || '';
    if (query && !resolveOwnerId()) rememberPendingSearch(query);
    if (settings.openInNewTab) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    location.assign(this.href);
  }

  function createButton(query, key) {
    var url = buildSearchUrl(query);
    var link = document.createElement('a');
    link.className = BTN_CLASS;
    link.setAttribute(BTN_ATTR, '');
    link.setAttribute(BTN_KEY, key);
    link.setAttribute('data-vkt-query', query);
    link.setAttribute('href', url);
    link.setAttribute('target', settings.openInNewTab ? '_blank' : '_self');
    link.setAttribute('rel', 'noopener noreferrer');
    link.setAttribute('title', 'Найти «' + query + '» в аудио VK');
    link.setAttribute('aria-label', 'Найти «' + query + '» в аудио VK');
    link.setAttribute('draggable', 'false');
    link.innerHTML = ICON_SVG;
    link.addEventListener('click', onButtonClick);
    link.addEventListener('auxclick', function (event) {
      if (event.button !== 1) return;
      var query = link.getAttribute('data-vkt-query') || '';
      if (query && !resolveOwnerId()) rememberPendingSearch(query);
    });
    link.addEventListener('mousedown', stopPropagation);
    link.addEventListener('pointerdown', stopPropagation);
    link.addEventListener('mouseup', stopPropagation);
    return link;
  }

  function buttonsIn(container) {
    var map = new Map();
    container.querySelectorAll('a.' + BTN_CLASS).forEach(function (button) {
      var key = button.getAttribute(BTN_KEY);
      if (key !== null && !map.has(key)) map.set(key, button);
    });
    return map;
  }

  function removeButtonsBeyond(container, count) {
    container.querySelectorAll('a.' + BTN_CLASS).forEach(function (button) {
      var key = parseInt(button.getAttribute(BTN_KEY) || '', 10);
      if (!isFinite(key) || key >= count) button.remove();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Обработка поста                                                     */
  /* ------------------------------------------------------------------ */

  function postHasMedia(post) {
    return !!post.querySelector(MEDIA_SELECTOR);
  }

  function findPostRoot(container) {
    // Сначала ищем именно контейнер поста: у самого span[data-testid="post_text"]
    // в VK тоже бывает data-post-id, и closest() без этого вернул бы его.
    var post = container.closest('[data-testid="post"]');
    if (!post && container.parentElement) {
      post = container.parentElement.closest(POST_SELECTOR);
    }
    return post;
  }

  function processTextElement(container) {
    var post = findPostRoot(container);
    if (!post) return;

    // Не вставляем кнопки в редактор поста/комментария.
    if (container.isContentEditable || container.closest('[contenteditable="true"], textarea')) return;

    // Обязательное условие по умолчанию: в посте есть аудио- или видеовложение.
    if (settings.requireMedia && !postHasMedia(post)) return;

    var lines = extractLines(container);
    if (!lines.length) return;

    var tracks = [];
    for (var i = 0; i < lines.length; i++) {
      var parsed = parseTrackLine(lines[i].text);
      if (parsed) {
        parsed.anchor = lines[i].anchor;
        parsed.lastTextNode = lines[i].lastTextNode;
        tracks.push(parsed);
      }
    }

    if (tracks.length < settings.minTracks) {
      var unnumbered = collectUnnumberedTracks(lines);
      if (unnumbered.length > tracks.length) tracks = unnumbered;
    }

    if (tracks.length < settings.minTracks) {
      removeButtonsBeyond(container, 0);
      return;
    }

    var existing = buttonsIn(container);
    for (var index = 0; index < tracks.length; index++) {
      var track = tracks[index];
      var key = String(index);
      var url = buildSearchUrl(track.query);
      var button = existing.get(key);

      if (button) {
        if (button.getAttribute('data-vkt-query') === track.query &&
            button.getAttribute('href') === url) {
          continue;
        }
        // Текст поста изменился — старую кнопку убираем и ставим заново
        // в правильное место.
        button.remove();
      }

      button = createButton(track.query, key);
      if (track.anchor && track.anchor.parentNode) {
        track.anchor.parentNode.insertBefore(button, track.anchor);
      } else {
        var point = endInsertionPoint(track.lastTextNode, container);
        if (point) point.parent.insertBefore(button, point.before);
        else container.appendChild(button);
      }
    }

    removeButtonsBeyond(container, tracks.length);
  }

  function scan() {
    if (!settings.enabled) return;
    refreshOwnerId();
    var containers = document.querySelectorAll(TEXT_SELECTOR);
    for (var i = 0; i < containers.length; i++) {
      try {
        processTextElement(containers[i]);
      } catch (e) { /* один пост не должен ломать остальные */ }
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, 250);
  }

  /* ------------------------------------------------------------------ */
  /* Наблюдение за страницей                                             */
  /* ------------------------------------------------------------------ */

  function removeAllButtons() {
    document.querySelectorAll('a.' + BTN_CLASS).forEach(function (button) {
      button.remove();
    });
  }

  function startWatching() {
    if (!observer && document.documentElement) {
      observer = new MutationObserver(function () {
        scheduleScan();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (!navTimer) {
      navTimer = setInterval(checkNavigation, 1000);
    }
  }

  function stopWatching() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (navTimer) {
      clearInterval(navTimer);
      navTimer = null;
    }
  }

  function checkNavigation() {
    var href = location.href;
    if (href === lastHref) return;
    lastHref = href;

    var route = location.pathname + location.search;
    if (route === lastRoute) return; // изменился только hash
    lastRoute = route;

    removeAllButtons();
    refreshOwnerId();
    handlePendingSearch();
    scheduleScan();
  }

  function applyEnabledState() {
    if (!document.documentElement) return;
    document.documentElement.classList.toggle('vkt-tracklist-disabled', !settings.enabled);

    if (!settings.enabled) {
      stopWatching();
      removeAllButtons();
      return;
    }

    startWatching();
    refreshOwnerId();
    scheduleScan();
  }

  function boot() {
    if (booted) return;
    booted = true;
    applyEnabledState();
  }

  function watchSettings() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
        var next = Object.assign({}, settings);
        Object.keys(changes).forEach(function (key) {
          if (changes[key].newValue === undefined) delete next[key];
          else next[key] = changes[key].newValue;
        });
        applySettings(next);
        removeAllButtons();
        applyEnabledState();
      });
    } catch (e) { /* ignore */ }
  }

  function init() {
    storageGet('sync', DEFAULTS, function (values) {
      applySettings(values);
      storageGet('local', { detectedAudioOwnerId: '', pendingAudioSearch: null }, function (local) {
        if (!ownerIdFromDom && local && local.detectedAudioOwnerId) {
          ownerIdFromDom = String(local.detectedAudioOwnerId);
        }
        watchSettings();
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', boot, { once: true });
        } else {
          boot();
        }
        handlePendingSearch(local && local.pendingAudioSearch);
      });
    });
  }

  // Небольшой отладочный интерфейс (живёт только в изолированном мире
  // расширения и не виден странице). Используется тестами.
  try {
    window.__vktTracklistSearch = {
      version: '1.1.0',
      parse: parseTrackLine,
      parseLoose: parseLooseTrack,
      isHeader: isTracklistHeader,
      buildUrl: buildSearchUrl,
      extract: extractLines,
      scan: scan
    };
  } catch (e) { /* ignore */ }

  init();
})();
