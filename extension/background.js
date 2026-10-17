/*
 * Клик по иконке расширения открывает страницу настроек.
 */
chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
