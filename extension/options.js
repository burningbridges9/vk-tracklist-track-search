/*
 * Страница настроек.
 */
(function () {
  'use strict';

  var DEFAULTS = (window.VKT && window.VKT.DEFAULTS) || {
    enabled: true,
    requireMedia: true,
    minTracks: 3,
    openInNewTab: true,
    queryEncoding: 'double',
    audioOwnerId: ''
  };

  var els = {
    form: document.getElementById('settings'),
    enabled: document.getElementById('enabled'),
    requireMedia: document.getElementById('requireMedia'),
    minTracks: document.getElementById('minTracks'),
    openInNewTab: document.getElementById('openInNewTab'),
    queryEncoding: document.getElementById('queryEncoding'),
    audioOwnerId: document.getElementById('audioOwnerId'),
    detected: document.getElementById('detected'),
    preview: document.getElementById('preview'),
    status: document.getElementById('status'),
    reset: document.getElementById('reset'),
    version: document.getElementById('version')
  };

  var saveTimer = null;
  var statusTimer = null;
  var detectedId = '';

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function readForm() {
    return {
      enabled: els.enabled.checked,
      requireMedia: els.requireMedia.checked,
      minTracks: clampInt(els.minTracks.value, 1, 50, DEFAULTS.minTracks),
      openInNewTab: els.openInNewTab.checked,
      queryEncoding: els.queryEncoding.value === 'single' ? 'single' : 'double',
      audioOwnerId: String(els.audioOwnerId.value || '').replace(/\D/g, '').slice(0, 20)
    };
  }

  function fill(values) {
    var settings = Object.assign({}, DEFAULTS, values);
    els.enabled.checked = settings.enabled !== false;
    els.requireMedia.checked = settings.requireMedia !== false;
    els.minTracks.value = clampInt(settings.minTracks, 1, 50, DEFAULTS.minTracks);
    els.openInNewTab.checked = settings.openInNewTab !== false;
    els.queryEncoding.value = settings.queryEncoding === 'single' ? 'single' : 'double';
    els.audioOwnerId.value = String(settings.audioOwnerId || '').replace(/\D/g, '').slice(0, 20);
    els.audioOwnerId.placeholder = detectedId || 'например, 123456789';
  }

  function updatePreview() {
    var settings = readForm();
    var query = 'Grum - Stay With Me';
    var once = encodeURIComponent(query);
    var encoded = settings.queryEncoding === 'single' ? once : encodeURIComponent(once);
    els.preview.textContent =
      'https://vk.ru/audios' + (settings.audioOwnerId || detectedId) + '?q=' + encoded;
  }

  function renderDetected(id) {
    detectedId = String(id || '').replace(/\D/g, '').slice(0, 20);
    if (detectedId) {
      els.detected.innerHTML =
        'ID вашей музыки определён автоматически: <b>' + detectedId + '</b>. ' +
        'Он уже используется, если поле выше пустое.';
      els.audioOwnerId.placeholder = detectedId;
    } else {
      els.detected.innerHTML =
        'ID пока не определён. Откройте <b>vk.ru/audios</b> один раз — расширение запомнит его само.';
      els.audioOwnerId.placeholder = 'например, 123456789';
    }
    updatePreview();
  }

  function setStatus(text, ok) {
    els.status.textContent = text;
    els.status.style.color = ok ? '' : '#e64646';
    els.status.classList.add('visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      els.status.classList.remove('visible');
    }, 1800);
  }

  function save() {
    var settings = readForm();
    els.minTracks.value = settings.minTracks;
    els.audioOwnerId.value = settings.audioOwnerId;

    try {
      chrome.storage.sync.set(settings, function () {
        var error = chrome.runtime.lastError;
        setStatus(error ? 'Ошибка сохранения' : 'Сохранено', !error);
      });
    } catch (e) {
      setStatus('Ошибка сохранения', false);
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }

  function onFormChange() {
    updatePreview();
    scheduleSave();
  }

  els.version.textContent = (window.VKT && window.VKT.VERSION) || '1.1.0';

  els.audioOwnerId.addEventListener('input', function () {
    var cleaned = this.value.replace(/\D/g, '').slice(0, 20);
    if (cleaned !== this.value) this.value = cleaned;
  });

  els.form.addEventListener('input', onFormChange);
  els.form.addEventListener('change', onFormChange);

  els.reset.addEventListener('click', function () {
    fill(DEFAULTS);
    updatePreview();
    save();
  });

  try {
    chrome.storage.sync.get(DEFAULTS, function (stored) {
      fill(Object.assign({}, DEFAULTS, stored || {}));
      updatePreview();
    });

    chrome.storage.local.get({ detectedAudioOwnerId: '' }, function (local) {
      renderDetected(String((local && local.detectedAudioOwnerId) || ''));
      fill(readForm());
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.detectedAudioOwnerId) {
        renderDetected(String(changes.detectedAudioOwnerId.newValue || ''));
      }
    });
  } catch (e) { /* ignore */ }

  updatePreview();
})();
