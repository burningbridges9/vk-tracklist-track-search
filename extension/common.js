/*
 * VK Tracklist Search — общие настройки по умолчанию.
 * Подключается и в content script (до content.js), и на страницу настроек.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    requireMedia: true,
    minTracks: 3,
    openInNewTab: true,
    queryEncoding: 'double',
    audioOwnerId: ''
  };

  window.VKT = window.VKT || {};
  window.VKT.DEFAULTS = DEFAULTS;
  window.VKT.VERSION = '1.1.0';
})();
