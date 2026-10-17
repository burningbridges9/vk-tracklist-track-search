/*
 * Тесты content script на jsdom: поднимаем тестовую страницу из fixture.html,
 * ждём, пока content.js расставит кнопки, и проверяем результат.
 *
 * Запуск:
 *   node test/run-tests.mjs
 * (jsdom установлен в test/.deps, см. README)
 */
import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPS = path.join(HERE, '.deps', 'node_modules');
const PNPM_DEPS = path.join(DEPS, '.pnpm', 'node_modules');

// pnpm кладёт транзитивные зависимости jsdom в .pnpm/node_modules — добавляем
// эту папку в пути поиска, чтобы тесты запускались одной командой.
if (existsSync(PNPM_DEPS)) {
  process.env.NODE_PATH = PNPM_DEPS;
  Module._initPaths();
}

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(path.join(DEPS, 'jsdom'));
const FIXTURE_HTML = readFileSync(path.join(HERE, 'fixture.html'), 'utf8');
const FIXTURE_URL = pathToFileURL(path.join(HERE, 'fixture.html')).href;
const EXTENSION = path.join(HERE, '..', 'extension');
const OPTIONS_HTML = readFileSync(path.join(EXTENSION, 'options.html'), 'utf8');
const OPTIONS_URL = pathToFileURL(path.join(EXTENSION, 'options.html')).href;

let failures = 0;
let checks = 0;

function check(name, condition, extra) {
  checks++;
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  }
}

function countsOf(result) {
  const counts = {};
  for (const [id, post] of Object.entries(result.posts)) counts[id] = post.count;
  return counts;
}

async function load(query) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  virtualConsole.on('error', (message) => errors.push(String(message)));

  const dom = new JSDOM(FIXTURE_HTML, {
    url: FIXTURE_URL + query,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  const deadline = Date.now() + 15000;
  let text = 'pending';

  while (Date.now() < deadline) {
    const node = window.document.getElementById('result');
    text = node ? node.textContent : 'pending';
    if (text && text !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  let result;
  try {
    result = JSON.parse(text);
  } finally {
    window.close();
  }
  return { result, errors };
}

async function loadOptions() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));

  const dom = new JSDOM(OPTIONS_HTML, {
    url: OPTIONS_URL,
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole,
    beforeParse(window) {
      window.chrome = {
        runtime: { lastError: null },
        storage: {
          sync: {
            get(defaults, callback) {
              callback(Object.assign({}, defaults, {
                enabled: true,
                requireMedia: false,
                minTracks: 5,
                openInNewTab: false,
                queryEncoding: 'single',
                audioOwnerId: '123456789'
              }));
            },
            set(values, callback) {
              window.__savedSettings = values;
              if (callback) callback();
            }
          },
          local: {
            get(defaults, callback) {
              callback(Object.assign({}, defaults, { detectedAudioOwnerId: '123456789' }));
            },
            set() {}
          },
          onChanged: { addListener() {} }
        }
      };
    }
  });

  const { window } = dom;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const preview = window.document.getElementById('preview');
    if (preview && preview.textContent && preview.textContent.indexOf('https://vk.ru/audios') === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { dom, errors };
}

async function main() {
  console.log('\n[1] Настройки по умолчанию (аудио/видео обязательно)');
  {
    const { result, errors } = await load('?uid=123456789');

    check('нет ошибок на странице', errors.length === 0, errors);
    check('версия content script', result.version === '1.1.0', result.version);

    check('треклист с аудио — 37 кнопок', result.posts['media-post'].count === 37, countsOf(result));
    check('треклист без вложений — 0 кнопок', result.posts['nomedia-post'].count === 0);
    check('пост только с фото — 0 кнопок', result.posts['photo-post'].count === 0);
    check('треклист с видео — 3 кнопки', result.posts['video-post'].count === 3);
    check('нумерованный список без дефисов — 0 кнопок', result.posts['list-post'].count === 0);
    check('меньше минимума строк — 0 кнопок', result.posts['short-post'].count === 0);

    check(
      'треклист без номеров с заголовком — 25 кнопок',
      result.posts['unnumbered-post'].count === 25,
      countsOf(result)
    );
    check(
      'строка-название выпуска не стала треком',
      result.posts['unnumbered-post'].queries.indexOf(
        'Elias Erium - The Outer Experience 063 (Live from Stereo, Part 2)'
      ) === -1,
      result.posts['unnumbered-post'].queries
    );
    check(
      'первая кнопка — первый трек треклиста',
      result.posts['unnumbered-post'].queries[0] === 'Molac, Plecta - Zenith (Original Mix)',
      result.posts['unnumbered-post'].queries[0]
    );
    check(
      'ненумерованный блок без заголовка — 6 кнопок',
      result.posts['unnumbered-run-post'].count === 6,
      countsOf(result)
    );
    check(
      '3 строки без заголовка — 0 кнопок',
      result.posts['unnumbered-short-post'].count === 0,
      countsOf(result)
    );
    check(
      'название выпуска не приклеилось к блоку без заголовка',
      result.posts['unnumbered-title-post'].count === 6,
      countsOf(result)
    );
    check(
      'разбор ненумерованных строк',
      result.loose.every((sample) => sample.ok),
      result.loose.filter((sample) => !sample.ok)
    );

    const hrefs = result.posts['media-post'].hrefs;
    check(
      'ссылка для «04 Grum - Stay With Me»',
      hrefs[3] === 'https://vk.ru/audios123456789?q=Grum%2520-%2520Stay%2520With%2520Me',
      hrefs[3]
    );
    check(
      'ссылка для строки с «&»',
      hrefs[0] === 'https://vk.ru/audios123456789?q=GXD%2520%2526%2520Elle%2520Vee%2520-%2520Sail%2520(Ginchy%2520Remix)',
      hrefs[0]
    );

    const placements = result.posts['media-post'].placements;
    check(
      'кнопка стоит в конце строки 01',
      placements[0].text &&
        placements[0].text.endsWith('Sail (Ginchy Remix)') &&
        placements[0].inPostText,
      placements[0]
    );
    check(
      'кнопка стоит в конце последней строки 37',
      placements[2].text &&
        placements[2].text.endsWith('(Will Atkinson Bootleg)') &&
        placements[2].inPostText,
      placements[2]
    );

    const unnumberedPlacements = result.posts['unnumbered-post'].placements;
    check(
      'кнопка стоит в конце ненумерованной строки',
      unnumberedPlacements[0].text &&
        unnumberedPlacements[0].text.endsWith('Zenith (Original Mix)') &&
        unnumberedPlacements[0].inPostText,
      unnumberedPlacements[0]
    );

    check('разбор строк треклиста', result.parse.every((sample) => sample.ok), result.parse.filter((sample) => !sample.ok));

    // Неразобранные строки не должны появляться в ссылках.
    check(
      'в ссылках нет названий блоков',
      hrefs.every((href) => !/Progressive%2520Pick|Tune%2520Of%2520The%2520Week/.test(href))
    );
  }

  console.log('\n[2] Без требования аудио/видео (media=0)');
  {
    const { result, errors } = await load('?uid=123456789&media=0');
    check('нет ошибок на странице', errors.length === 0, errors);

    check('текстовый треклист — 37 кнопок', result.posts['media-post'].count === 37);
    check('треклист без вложений — 37 кнопок', result.posts['nomedia-post'].count === 37);
    check('пост с фото — 37 кнопок', result.posts['photo-post'].count === 37);
    check('нумерованный список — 0 кнопок', result.posts['list-post'].count === 0);
    check('ненумерованный треклист — 25 кнопок', result.posts['unnumbered-post'].count === 25);
  }

  console.log('\n[3] Выключенное расширение (enabled=0)');
  {
    const { result, errors } = await load('?uid=123456789&enabled=0');
    check('нет ошибок на странице', errors.length === 0, errors);
    check('все кнопки убраны', Object.values(result.posts).every((post) => post.count === 0));
    check('на html выставлен класс отключения', result.disabledClass === true);
  }

  console.log('\n[4] Одинарное кодирование (enc=single)');
  {
    const { result } = await load('?uid=123456789&enc=single');
    check(
      'ссылка с %20 вместо %2520',
      result.posts['media-post'].hrefs[3] ===
        'https://vk.ru/audios123456789?q=Grum%20-%20Stay%20With%20Me',
      result.posts['media-post'].hrefs[3]
    );
  }

  console.log('\n[5] Манифест расширения');
  {
    const manifest = JSON.parse(readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8'));
    check('manifest_version = 3', manifest.manifest_version === 3);
    check('версия 1.1.0', manifest.version === '1.1.0', manifest.version);

    const referenced = [
      manifest.background.service_worker,
      manifest.options_ui.page,
      ...manifest.content_scripts.flatMap((script) => [...script.js, ...(script.css || [])]),
      ...Object.values(manifest.icons)
    ];
    const missing = referenced.filter((file) => !existsSync(path.join(EXTENSION, file)));
    check('все файлы манифеста существуют', missing.length === 0, missing);

    const matches = manifest.content_scripts.flatMap((script) => script.matches);
    check('подключение на vk.ru', matches.includes('https://vk.ru/*'), matches);
    check('подключение на vk.com', matches.includes('https://vk.com/*'), matches);
  }

  console.log('\n[6] Страница настроек');
  {
    const { dom, errors } = await loadOptions();
    const { window } = dom;
    const document = window.document;

    check('нет ошибок на странице настроек', errors.length === 0, errors);
    check('загружены настройки', document.getElementById('requireMedia').checked === false);
    check('поле минимума строк', document.getElementById('minTracks').value === '5');
    check('новая вкладка выключена', document.getElementById('openInNewTab').checked === false);
    check('кодирование single', document.getElementById('queryEncoding').value === 'single');
    check('ID владельца аудио', document.getElementById('audioOwnerId').value === '123456789');
    check(
      'пример ссылки',
      document.getElementById('preview').textContent ===
        'https://vk.ru/audios123456789?q=Grum%20-%20Stay%20With%20Me',
      document.getElementById('preview').textContent
    );
    check(
      'определённый ID показан в подсказке',
      document.getElementById('detected').textContent.indexOf('123456789') !== -1
    );
    check('версия на странице', document.getElementById('version').textContent === '1.1.0');

    const enabled = document.getElementById('enabled');
    enabled.checked = false;
    enabled.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      'изменения сохраняются в storage.sync',
      window.__savedSettings && window.__savedSettings.enabled === false,
      window.__savedSettings
    );

    window.close();
  }

  console.log(`\nИтого: ${checks - failures}/${checks} проверок прошло.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
