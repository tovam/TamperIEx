// ==UserScript==
// @name         TamperIEx
// @namespace    local.tamperiex
// @version      1.7.0
// @description  Control Elixir/IEx functions from a local web interface.
// @license      MIT
// @homepageURL  https://github.com/tovam/tamperiex
// @supportURL   https://github.com/tovam/tamperiex/issues
// @updateURL    https://raw.githubusercontent.com/tovam/tamperiex/master/tamperiex.user.js
// @downloadURL  https://raw.githubusercontent.com/tovam/tamperiex/master/tamperiex.user.js
// @match        http://localhost/*
// @match        https://localhost/*
// @match        http://127.0.0.1/*
// @match        https://127.0.0.1/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * TamperIEx displays Elixir functions declared with `defapi` in your browser.
 * The bridge must already be installed in ~/tamperiex.
 *
 * In the Elixir project, create or update `.iex.exs`:
 *
 *   Code.require_file(Path.expand("~/tamperiex/tamperiex.exs"))
 *
 *   defmodule UX.FeatureFlags do
 *     use TamperIEx
 *
 *     defapi set_flag((enabled \\ false) :: :boolean) do
 *       MyApp.FeatureFlags.set(:my_flag, enabled)
 *     end
 *   end
 *
 *   TamperIEx.start(UX.FeatureFlags, watch: true)
 *
 * Then run `iex -S mix`, open localhost, and press Command K (`⌘K`).
 * The IEx button is hidden by default; you can display it in Settings.
 * In Calls, select `New preset`, choose a function, fill in its arguments,
 * and give it a name. You can then run it with one click.
 * Only these presets are stored; there is no execution history.
 * Whenever `.iex.exs` is saved, the module reloads and the active panel
 * automatically updates its actions.
 * No `.env` changes are required.
 */

(function () {
  'use strict';

  var FIRST_PORT = 55431;
  var PORT_COUNT = 20;
  var PROBE_TIMEOUT = 600;
  var REQUEST_TIMEOUT = 3000;
  var VERIFY_INTERVAL = 5000;
  var IDLE_TIMEOUT = 30000;
  var STORAGE_PREFIX = 'tamperIEx.choice:';
  var SAVED_CALLS_PREFIX = 'tamperIEx.savedCalls:';
  var ACTIVE_TAB_PREFIX = 'tamperIEx.activeTab:';
  var SETTINGS_KEY = 'tamperIEx.settings';
  var REPOSITORY_URL = 'https://github.com/tovam/tamperiex';
  var BRIDGE_URL =
    'https://raw.githubusercontent.com/tovam/tamperiex/master/tamperiex.exs';
  var USERSCRIPT_URL =
    'https://raw.githubusercontent.com/tovam/tamperiex/master/tamperiex.user.js';
  var BRIDGE_UPDATE_COMMAND =
    'wget -O ~/tamperiex/tamperiex.exs ' + BRIDGE_URL;
  var fieldSequence = 0;
  var sessionGeneration = 0;
  var popupIsOpen = false;
  var popupIsBlocked = false;
  var helpIsOpen = false;
  var settingsIsOpen = false;
  var focusBeforeOpen = null;
  var activeBridge = null;
  var monitorTimer = null;
  var idleTimer = null;
  var lastVerificationAt = 0;
  var verificationInFlight = false;

  function element(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function loadSettings() {
    var stored = GM_getValue(SETTINGS_KEY, null);

    return {
      showLauncher: Boolean(stored && stored.showLauncher === true)
    };
  }

  var settings = loadSettings();

  function saveSettings() {
    GM_setValue(SETTINGS_KEY, {
      showLauncher: settings.showLauncher
    });
  }

  function request(options) {
    return new Promise(function (resolve, reject) {
      var headers = Object.assign({}, options.headers || {}, {
        'X-TamperIEx': '1'
      });

      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: options.url,
        headers: headers,
        data: options.data,
        timeout: options.timeout || REQUEST_TIMEOUT,
        onload: resolve,
        onerror: function () {
          reject(new Error('Connection failed'));
        },
        ontimeout: function () {
          reject(new Error('Request timed out'));
        },
        onabort: function () {
          reject(new Error('Request aborted'));
        }
      });
    });
  }

  function responseHeader(response, expectedName) {
    var expected = expectedName.toLowerCase();
    var lines = String(response.responseHeaders || '').split(/\r?\n/);

    for (var index = 0; index < lines.length; index += 1) {
      var separator = lines[index].indexOf(':');
      if (separator < 0) continue;

      var name = lines[index].slice(0, separator).trim().toLowerCase();
      if (name === expected) {
        return lines[index].slice(separator + 1).trim();
      }
    }

    return null;
  }

  function bridgeUrl(port, path) {
    return 'http://127.0.0.1:' + port + path;
  }

  function validateDiscovery(value, expectedPort) {
    if (!value || value.protocol !== 'tamperiex' || value.version !== 1) {
      throw new Error('Unknown discovery response');
    }

    if (
      typeof value.id !== 'string' ||
      typeof value.name !== 'string' ||
      !Number.isInteger(value.port) ||
      value.port !== expectedPort
    ) {
      throw new Error('Invalid bridge identity');
    }

    if (
      value.manifestRevision !== undefined &&
      value.manifestRevision !== null &&
      typeof value.manifestRevision !== 'string'
    ) {
      throw new Error('Invalid manifest revision');
    }

    return value;
  }

  async function probe(port) {
    var response = await request({
      url: bridgeUrl(port, '/discover'),
      timeout: PROBE_TIMEOUT
    });

    if (response.status !== 200) {
      throw new Error('HTTP ' + response.status);
    }

    return validateDiscovery(JSON.parse(response.responseText), port);
  }

  async function scanBridges() {
    // Intentionally called only by searchApplications(), after a user action.
    var probes = [];

    for (var offset = 0; offset < PORT_COUNT; offset += 1) {
      probes.push(probe(FIRST_PORT + offset));
    }

    var settled = await Promise.allSettled(probes);
    var seen = new Set();
    var bridges = [];

    settled.forEach(function (result) {
      if (result.status !== 'fulfilled') return;

      var bridge = result.value;
      var key = bridge.id + ':' + bridge.port;

      if (!seen.has(key)) {
        seen.add(key);
        bridges.push(bridge);
      }
    });

    bridges.sort(function (left, right) {
      return left.port - right.port;
    });

    return bridges;
  }

  function applicationPort() {
    if (location.port) return location.port;
    return location.protocol === 'https:' ? '443' : '80';
  }

  function applicationKey() {
    var localHosts = ['localhost', '127.0.0.1', '::1'];

    if (localHosts.indexOf(location.hostname) !== -1) {
      return 'local-port:' + applicationPort();
    }

    return location.protocol + '//' + location.host;
  }

  function storageKey() {
    return STORAGE_PREFIX + applicationKey();
  }

  function readChoice() {
    var value = GM_getValue(storageKey(), null);

    if (
      value &&
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      Number.isInteger(value.port)
    ) {
      return value;
    }

    return null;
  }

  function saveChoice(bridge) {
    GM_setValue(storageKey(), {
      id: bridge.id,
      name: bridge.name,
      port: bridge.port,
      application: applicationKey(),
      savedAt: Date.now()
    });
  }

  function savedCallsKey(server) {
    return SAVED_CALLS_PREFIX + server.id;
  }

  function activeTabKey(server) {
    return ACTIVE_TAB_PREFIX + server.id;
  }

  function readSavedCalls(server) {
    var value = GM_getValue(savedCallsKey(server), []);

    if (!Array.isArray(value)) return [];

    return value.filter(function (savedCall) {
      return Boolean(
        savedCall &&
          typeof savedCall.id === 'string' &&
          typeof savedCall.name === 'string' &&
          typeof savedCall.functionName === 'string' &&
          Array.isArray(savedCall.arguments) &&
          savedCall.arguments.every(function (argument) {
            return typeof argument === 'string' && argument.indexOf(':') > 0;
          })
      );
    });
  }

  function writeSavedCalls(server, savedCalls) {
    GM_setValue(savedCallsKey(server), savedCalls);
  }

  function localId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }

    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function readActiveTab(server) {
    return GM_getValue(activeTabKey(server), 'functions') === 'saved'
      ? 'saved'
      : 'functions';
  }

  function writeActiveTab(server, tabName) {
    GM_setValue(activeTabKey(server), tabName);
  }

  var host = document.createElement('div');
  host.id = '__tamperiex_ux';
  document.documentElement.appendChild(host);

  var shadow = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = [
    ':host {',
    '  all: initial; color-scheme: light;',
    '  --ti-accent: #6842d8; --ti-accent-hover: #5634bb; --ti-accent-soft: #eee9ff;',
    '  --ti-bg: #f4f5f7; --ti-surface: #ffffff; --ti-text: #20242a;',
    '  --ti-muted: #68717d; --ti-line: #d9dde4; --ti-soft: #eceff3;',
    '}',
    '* { box-sizing: border-box; }',
    'button, input, select { font: inherit; color: inherit; }',
    '[hidden], .hidden { display: none !important; }',
    '.launcher {',
    '  position: fixed; right: 0; bottom: 72px; z-index: 2147483646;',
    '  width: 38px; height: 28px; border: 1px solid #4d2fa9; border-right: 0;',
    '  border-radius: 3px 0 0 3px; color: #fff; background: var(--ti-accent);',
    '  font: 740 10px/1 system-ui, sans-serif; cursor: pointer;',
    '  box-shadow: 0 3px 10px rgba(28, 22, 45, .18);',
    '}',
    '.launcher:hover { width: 42px; background: var(--ti-accent-hover); }',
    '.launcher:focus-visible, .button:focus-visible, .close:focus-visible,',
    '.help-toggle:focus-visible, .help-back:focus-visible, .copy-button:focus-visible,',
    '.help-link:focus-visible, .tab:focus-visible, .icon-button:focus-visible,',
    'input:focus-visible, select:focus-visible { outline: 2px solid #8d70eb; outline-offset: 1px; }',
    '.overlay {',
    '  position: fixed; inset: 0; z-index: 2147483647; display: flex;',
    '  justify-content: flex-end; align-items: flex-start; padding: 10px;',
    '  background: rgba(16, 20, 27, .12);',
    '  font: 11px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '}',
    '.dialog {',
    '  position: relative; display: flex; flex-direction: column;',
    '  width: min(520px, calc(100vw - 20px)); height: min(500px, calc(100vh - 20px));',
    '  min-width: 0; overflow: hidden; color: var(--ti-text); background: var(--ti-bg);',
    '  border: 1px solid #aeb5bf; border-radius: 4px;',
    '  box-shadow: 0 14px 38px rgba(16, 20, 27, .25);',
    '}',
    '.header {',
    '  min-height: 38px; display: flex; align-items: center; justify-content: space-between;',
    '  padding: 4px 6px 4px 9px; color: #f8fafc; background: #222831;',
    '  border-bottom: 1px solid #151a20;',
    '}',
    '.title { margin: 0; font-size: 12px; font-weight: 760; letter-spacing: .01em; }',
    '.header-actions { display: flex; align-items: center; gap: 1px; }',
    '.help-toggle {',
    '  height: 26px; padding: 0 6px; border: 0; border-radius: 2px; cursor: pointer;',
    '  color: #d9dfe7; background: transparent; font-size: 9.5px; font-weight: 700;',
    '}',
    '.close {',
    '  width: 26px; height: 26px; border: 0; border-radius: 2px; cursor: pointer;',
    '  color: #d9dfe7; background: transparent; font-size: 17px; line-height: 1;',
    '}',
    '.help-toggle:hover, .help-toggle[aria-expanded="true"], .close:hover {',
    '  color: #fff; background: #38414d;',
    '}',
    '.content { flex: 1; min-height: 0; padding: 0; overflow: auto; background: var(--ti-bg); }',
    '.content.workspace-content { display: flex; flex-direction: column; overflow: hidden; }',
    '.loading { padding: 18px 8px; color: var(--ti-muted); font-size: 10px; text-align: center; }',
    '.notice {',
    '  margin: 6px 8px; padding: 6px 8px; border-left: 2px solid #b88400;',
    '  color: #5b4611; background: #fff7dc; font-size: 10px; line-height: 1.4;',
    '}',
    '.notice.error, .error { border-left-color: #c93645; color: #7f2630; background: #ffebed; }',
    '.empty { color: var(--ti-muted); text-align: center; padding: 24px 10px; font-size: 10px; }',
    '.empty strong { display: block; margin-bottom: 3px; color: var(--ti-text); font-size: 11px; }',
    '.server-list { display: grid; gap: 0; margin: 0 0 7px; border-top: 1px solid var(--ti-line); }',
    '.server-option {',
    '  display: grid; grid-template-columns: 18px minmax(0, 1fr) max-content;',
    '  gap: 7px; align-items: center; padding: 7px 9px; cursor: pointer;',
    '  border: 0; border-bottom: 1px solid var(--ti-line); background: transparent;',
    '}',
    '.server-option:hover, .server-option:has(input:checked) { background: #e9edf4; }',
    '.server-option input { margin: 0; accent-color: var(--ti-accent); }',
    '.server-name { overflow: hidden; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }',
    '.server-port, .muted { color: var(--ti-muted); font-size: 9px; }',
    '.workspace-bar {',
    '  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px;',
    '  align-items: center; min-height: 38px; padding: 5px 8px;',
    '  background: var(--ti-surface); border-bottom: 1px solid var(--ti-line);',
    '}',
    '.server-select {',
    '  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 6px;',
    '  align-items: center; min-width: 0;',
    '}',
    '.server-select::before {',
    '  content: ""; grid-row: 1 / 3; width: 6px; height: 6px;',
    '  border-radius: 50%; background: #2f9d57; box-shadow: 0 0 0 2px #dff3e5;',
    '}',
    '.server-primary { overflow: hidden; font-size: 10.5px; font-weight: 720; text-overflow: ellipsis; white-space: nowrap; }',
    '.context { overflow: hidden; color: var(--ti-muted); font-size: 8.5px; text-overflow: ellipsis; white-space: nowrap; }',
    '.workspace-tabs {',
    '  display: flex; flex: none; min-height: 30px; padding: 0 5px;',
    '  background: var(--ti-surface); border-bottom: 1px solid var(--ti-line);',
    '}',
    '.tab {',
    '  position: relative; min-width: 72px; height: 30px; padding: 0 9px;',
    '  border: 0; border-bottom: 2px solid transparent; cursor: pointer;',
    '  color: var(--ti-muted); background: transparent; font-size: 10px; font-weight: 680;',
    '}',
    '.tab:hover { color: var(--ti-text); background: #f5f6f8; }',
    '.tab[aria-selected="true"] { color: #4e2dac; border-bottom-color: var(--ti-accent); background: #fff; }',
    '.tab-count {',
    '  display: inline-grid; place-items: center; min-width: 16px; height: 15px; margin-left: 4px;',
    '  padding: 0 4px; border-radius: 8px; color: #59616c; background: #e8eaf0;',
    '  font-size: 8px; font-weight: 750;',
    '}',
    '.tab[aria-selected="true"] .tab-count { color: #4e2dac; background: var(--ti-accent-soft); }',
    '.workspace-panels { flex: 1; min-height: 0; overflow: hidden; }',
    '.tab-panel { height: 100%; overflow: auto; background: var(--ti-bg); }',
    '.filter-tools {',
    '  position: sticky; top: 0; z-index: 3; display: grid;',
    '  grid-template-columns: minmax(0, 1fr) max-content; gap: 6px; align-items: center;',
    '  padding: 5px 8px; background: rgba(255, 255, 255, .96); border-bottom: 1px solid var(--ti-line);',
    '}',
    '.filter-count { min-width: 38px; color: var(--ti-muted); font-size: 8.5px; text-align: right; }',
    'select, input[type="text"], input[type="number"], input[type="search"] {',
    '  width: 100%; min-width: 0; height: 26px; border: 1px solid #bcc3cd;',
    '  border-radius: 2px; padding: 3px 6px; color: var(--ti-text); background: #fff;',
    '  font-size: 10px;',
    '}',
    'select:hover, input[type="text"]:hover, input[type="number"]:hover, input[type="search"]:hover { border-color: #969fac; }',
    'input[type="search"] { appearance: none; }',
    '.button {',
    '  min-height: 26px; padding: 4px 8px; border: 1px solid #5634bb;',
    '  border-radius: 2px; color: #fff; background: var(--ti-accent);',
    '  font: 680 9.5px/1 system-ui, sans-serif; cursor: pointer;',
    '}',
    '.button:hover { background: var(--ti-accent-hover); }',
    '.button.secondary { border-color: #c6ccd5; color: #333b46; background: #eef1f5; }',
    '.button.secondary:hover { background: #e2e6ec; }',
    '.button:disabled { opacity: .55; cursor: wait; }',
    '.content > .button { align-self: start; margin: 0 8px 8px; }',
    '.actions { display: block; }',
    '.actions > .button { margin: 0 8px 8px; }',
    '.action-row {',
    '  display: grid;',
    '  grid-template-columns: minmax(118px, .6fr) minmax(210px, 1.4fr) 52px;',
    '  grid-template-areas: "meta fields run" "result result result";',
    '  gap: 5px 7px; align-items: center; min-width: 0; padding: 7px 8px;',
    '  border: 0; border-bottom: 1px solid var(--ti-line); background: var(--ti-surface);',
    '}',
    '.action-row:hover { background: #fafafd; }',
    '.action-meta { grid-area: meta; min-width: 0; align-self: start; padding-top: 1px; }',
    '.action-meta h3 { margin: 0; font-size: 11px; font-weight: 730; line-height: 1.25; }',
    '.signature { display: block; margin-top: 1px; color: #7b838e; font: 8.5px/1.25 ui-monospace, monospace; }',
    '.description { margin: 2px 0 0; color: var(--ti-muted); font-size: 9px; line-height: 1.3; }',
    '.fields {',
    '  grid-area: fields; display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));',
    '  gap: 4px 6px; min-width: 0; margin: 0;',
    '}',
    '.field { display: grid; gap: 1px; min-width: 0; }',
    '.field-label { overflow: hidden; color: #525b67; font-size: 8.5px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }',
    '.field > .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.toggle-row { display: flex; align-items: center; gap: 5px; min-height: 26px; }',
    '.toggle-row input {',
    '  position: relative; width: 26px; height: 14px; margin: 0; border: 1px solid #aab1bb;',
    '  border-radius: 8px; appearance: none; cursor: pointer; background: #d9dde3;',
    '}',
    '.toggle-row input::after {',
    '  content: ""; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px;',
    '  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .18);',
    '  transition: transform 100ms ease;',
    '}',
    '.toggle-row input:checked { border-color: #6540ce; background: var(--ti-accent); }',
    '.toggle-row input:checked::after { transform: translateX(12px); }',
    '.toggle-state { color: var(--ti-muted); font-size: 8.5px; }',
    '.action-run { grid-area: run; align-self: end; width: 52px; padding-inline: 4px; }',
    '.icon-button {',
    '  display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0;',
    '  border: 1px solid #c4cad3; border-radius: 2px; cursor: pointer;',
    '  color: #555f6c; background: #f5f6f8; font-size: 14px; line-height: 1;',
    '}',
    '.icon-button:hover { color: #4e2dac; border-color: #a996df; background: var(--ti-accent-soft); }',
    '.icon-button:disabled { opacity: .45; cursor: default; }',
    '.result {',
    '  grid-area: result; display: none; max-height: 140px; margin: 1px 0 0; padding: 5px 7px;',
    '  overflow: auto; border: 1px solid #cbd8c8; border-left: 2px solid #47824d;',
    '  border-radius: 1px; color: #253928; background: #eff7ef;',
    '  white-space: pre-wrap; overflow-wrap: anywhere; font: 9.5px/1.35 ui-monospace, monospace;',
    '}',
    '.result.visible { display: block; }',
    '.result.failure { border-color: #dfbcc1; border-left-color: #bd3646; color: #762733; background: #ffedef; }',
    '.saved-head {',
    '  display: flex; align-items: center; justify-content: space-between; gap: 8px;',
    '  min-height: 34px; padding: 4px 8px; color: var(--ti-muted);',
    '  background: var(--ti-surface); border-bottom: 1px solid var(--ti-line); font-size: 9px;',
    '}',
    '.saved-head strong { color: var(--ti-text); font-size: 10px; }',
    '.preset-builder {',
    '  display: grid; grid-template-columns: minmax(130px, .8fr) minmax(150px, 1.2fr);',
    '  gap: 6px 8px; padding: 7px 8px; background: #fff; border-bottom: 1px solid var(--ti-line);',
    '}',
    '.preset-builder > .field { align-self: end; }',
    '.preset-fields {',
    '  grid-column: 1 / -1; display: grid;',
    '  grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: 4px 6px;',
    '  padding-top: 5px; border-top: 1px dashed #d5d9e0;',
    '}',
    '.preset-fields-empty { color: var(--ti-muted); font-size: 8.5px; }',
    '.preset-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 5px; }',
    '.saved-list { display: block; }',
    '.saved-call {',
    '  display: grid; grid-template-columns: minmax(0, 1fr) 26px 52px;',
    '  grid-template-areas: "saved-meta delete saved-run" "result result result";',
    '  gap: 5px 7px; align-items: center; padding: 7px 8px;',
    '  background: var(--ti-surface); border-bottom: 1px solid var(--ti-line);',
    '}',
    '.saved-call:hover { background: #fafafd; }',
    '.saved-call.unavailable { background: #fafafa; }',
    '.saved-call-meta { grid-area: saved-meta; min-width: 0; }',
    '.saved-call-title {',
    '  display: block; overflow: hidden; margin: 0; font-size: 11px; font-weight: 730;',
    '  text-overflow: ellipsis; white-space: nowrap;',
    '}',
    '.saved-call-detail {',
    '  display: block; overflow: hidden; margin-top: 1px; color: var(--ti-muted);',
    '  font: 8.5px/1.3 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap;',
    '}',
    '.saved-warning { display: block; margin-top: 2px; color: #a04b23; font-size: 8.5px; }',
    '.saved-delete { grid-area: delete; }',
    '.saved-delete.confirm { color: #8b2630; border-color: #d5a7ad; background: #ffedef; font-size: 11px; }',
    '.saved-run { grid-area: saved-run; width: 52px; padding-inline: 4px; }',
    '.saved-call > .result { grid-area: result; }',
    '.help-panel {',
    '  position: absolute; inset: 38px 0 0; z-index: 30; overflow: auto;',
    '  color: var(--ti-text); background: var(--ti-bg);',
    '}',
    '.help-heading {',
    '  position: sticky; top: 0; z-index: 1; display: flex; align-items: center;',
    '  justify-content: space-between; min-height: 35px; padding: 5px 8px;',
    '  background: var(--ti-surface); border-bottom: 1px solid var(--ti-line);',
    '}',
    '.help-heading h3 { margin: 0; font-size: 11px; }',
    '.help-back {',
    '  min-height: 25px; padding: 3px 7px; border: 1px solid #c6ccd5;',
    '  border-radius: 2px; color: #333b46; background: #eef1f5;',
    '  font-size: 9px; font-weight: 700; cursor: pointer;',
    '}',
    '.help-back:hover { background: #e2e6ec; }',
    '.help-section { padding: 9px; border-bottom: 1px solid var(--ti-line); }',
    '.help-section h4 { margin: 0 0 4px; font-size: 10px; }',
    '.help-section p { margin: 0 0 6px; color: var(--ti-muted); font-size: 9px; line-height: 1.45; }',
    '.help-section p:last-child { margin-bottom: 0; }',
    '.settings-list { background: var(--ti-surface); border-bottom: 1px solid var(--ti-line); }',
    '.setting-row {',
    '  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px;',
    '  align-items: center; min-height: 48px; padding: 8px 9px; cursor: pointer;',
    '  border-bottom: 1px solid var(--ti-line);',
    '}',
    '.setting-row:hover { background: #f0f2f6; }',
    '.setting-copy { min-width: 0; }',
    '.setting-name { display: block; font-size: 10px; font-weight: 720; }',
    '.setting-description { display: block; margin-top: 2px; color: var(--ti-muted); font-size: 8.5px; }',
    '.setting-checkbox {',
    '  width: 16px; height: 16px; margin: 0; cursor: pointer; accent-color: var(--ti-accent);',
    '}',
    '.settings-status { min-height: 24px; margin: 0; padding: 6px 9px; color: #367941; font-size: 8.5px; }',
    '.command-row {',
    '  display: grid; grid-template-columns: minmax(0, 1fr) auto; min-width: 0;',
    '  margin: 5px 0; border: 1px solid #161b22; background: #222831;',
    '}',
    '.command-row code {',
    '  min-width: 0; overflow: auto; padding: 6px 7px; color: #e7ebf0;',
    '  white-space: nowrap; font: 8.5px/1.4 ui-monospace, monospace;',
    '}',
    '.copy-button {',
    '  min-width: 50px; border: 0; border-left: 1px solid #424b58; cursor: pointer;',
    '  color: #e7ebf0; background: #303844; font-size: 8.5px; font-weight: 700;',
    '}',
    '.copy-button:hover { background: #3a4553; }',
    '.copy-status { min-height: 14px; color: #367941; font-size: 8.5px; }',
    '.help-link {',
    '  color: #5432bd; font-weight: 720; text-decoration: underline;',
    '  text-decoration-thickness: 1px; text-underline-offset: 3px;',
    '}',
    '.help-link:hover { color: #3f2496; }',
    '.blocker {',
    '  position: absolute; inset: 38px 0 0; z-index: 20; display: grid;',
    '  place-items: start center; padding: 36px 16px; background: rgba(244, 245, 247, .97);',
    '}',
    '.blocker-panel { width: min(390px, 100%); padding: 0 0 0 10px; border-left: 2px solid var(--ti-accent); }',
    '.blocker-panel h3 { margin: 0 0 4px; font-size: 12px; }',
    '.blocker-message { margin: 0 0 9px; color: var(--ti-muted); font-size: 10px; line-height: 1.4; }',
    '.blocker-status { margin: 6px 0 0; color: var(--ti-muted); font-size: 8.5px; }',
    '@media (max-width: 620px) {',
    '  .overlay { padding: 0; }',
    '  .dialog { width: 100vw; height: 100vh; border: 0; border-radius: 0; }',
    '  .action-row {',
    '    grid-template-columns: minmax(0, 1fr) 52px;',
    '    grid-template-areas: "meta run" "fields fields" "result result";',
    '  }',
    '  .preset-builder { grid-template-columns: 1fr; }',
    '  .preset-fields, .preset-actions { grid-column: 1; }',
    '  .blocker { inset: 38px 0 0; }',
    '  .help-panel { inset: 38px 0 0; }',
    '}'
  ].join('\n');
  shadow.appendChild(style);

  var launcher = element(
    'button',
    settings.showLauncher ? 'launcher' : 'launcher hidden',
    'IEx'
  );
  launcher.type = 'button';
  launcher.title = 'Open TamperIEx (⌘K)';
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.setAttribute('aria-controls', '__tamperiex_dialog');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-keyshortcuts', 'Meta+K');
  launcher.setAttribute('aria-hidden', settings.showLauncher ? 'false' : 'true');
  shadow.appendChild(launcher);

  var overlay = element('div', 'overlay hidden');
  var dialog = element('section', 'dialog');
  dialog.id = '__tamperiex_dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', '__tamperiex_title');
  var header = element('header', 'header');
  var title = element('h2', 'title', 'TamperIEx');
  title.id = '__tamperiex_title';
  var headerActions = element('div', 'header-actions');
  var settingsButton = element('button', 'help-toggle', 'Settings');
  settingsButton.type = 'button';
  settingsButton.title = 'Interface settings';
  settingsButton.setAttribute('aria-controls', '__tamperiex_settings');
  settingsButton.setAttribute('aria-expanded', 'false');
  var helpButton = element('button', 'help-toggle', 'Help');
  helpButton.type = 'button';
  helpButton.title = 'Help and updates';
  helpButton.setAttribute('aria-controls', '__tamperiex_help');
  helpButton.setAttribute('aria-expanded', 'false');
  var closeButton = element('button', 'close', '×');
  closeButton.type = 'button';
  closeButton.title = 'Close';
  closeButton.setAttribute('aria-label', 'Close TamperIEx');
  var content = element('main', 'content');
  var blocker = element('div', 'blocker hidden');
  blocker.setAttribute('role', 'alertdialog');
  blocker.setAttribute('aria-live', 'assertive');
  var blockerPanel = element('div', 'blocker-panel');
  var blockerTitle = element('h3', null, 'Bridge unavailable');
  var blockerMessage = element('p', 'blocker-message');
  var blockerSearch = element(
    'button',
    'button',
    'Find application'
  );
  var blockerStatus = element('p', 'blocker-status');
  blockerSearch.type = 'button';

  var settingsPanel = element('aside', 'help-panel hidden');
  settingsPanel.id = '__tamperiex_settings';
  settingsPanel.setAttribute('role', 'region');
  settingsPanel.setAttribute('aria-labelledby', '__tamperiex_settings_title');

  var settingsHeading = element('div', 'help-heading');
  var settingsTitle = element('h3', null, 'Settings');
  settingsTitle.id = '__tamperiex_settings_title';
  var settingsBack = element('button', 'help-back', 'Back');
  settingsBack.type = 'button';
  settingsHeading.appendChild(settingsTitle);
  settingsHeading.appendChild(settingsBack);

  var settingsList = element('div', 'settings-list');
  var launcherSetting = element('label', 'setting-row');
  var launcherSettingCopy = element('span', 'setting-copy');
  launcherSettingCopy.appendChild(
    element('span', 'setting-name', 'Show the IEx button on pages')
  );
  launcherSettingCopy.appendChild(
    element(
      'span',
      'setting-description',
      'Disabled by default. The ⌘K shortcut always remains available.'
    )
  );
  var launcherSettingInput = element('input', 'setting-checkbox');
  launcherSettingInput.type = 'checkbox';
  launcherSettingInput.checked = settings.showLauncher;
  launcherSetting.appendChild(launcherSettingCopy);
  launcherSetting.appendChild(launcherSettingInput);
  var settingsStatus = element('p', 'settings-status');
  settingsStatus.setAttribute('role', 'status');
  settingsStatus.setAttribute('aria-live', 'polite');
  settingsList.appendChild(launcherSetting);
  settingsList.appendChild(settingsStatus);
  settingsPanel.appendChild(settingsHeading);
  settingsPanel.appendChild(settingsList);

  var helpPanel = element('aside', 'help-panel hidden');
  helpPanel.id = '__tamperiex_help';
  helpPanel.setAttribute('role', 'region');
  helpPanel.setAttribute('aria-labelledby', '__tamperiex_help_title');

  var helpHeading = element('div', 'help-heading');
  var helpTitle = element('h3', null, 'Help and updates');
  helpTitle.id = '__tamperiex_help_title';
  var helpBack = element('button', 'help-back', 'Back');
  helpBack.type = 'button';
  helpHeading.appendChild(helpTitle);
  helpHeading.appendChild(helpBack);

  var savedCallsHelp = element('section', 'help-section');
  savedCallsHelp.appendChild(element('h4', null, 'Presets'));
  savedCallsHelp.appendChild(
    element(
      'p',
      null,
      'In Calls, select New preset, choose a function, give it a name, and set each argument. You can then run the preset with one click. Executions are never added to a history.'
    )
  );

  var bridgeHelp = element('section', 'help-section');
  bridgeHelp.appendChild(element('h4', null, 'Update the bridge'));
  bridgeHelp.appendChild(
    element('p', null, 'Run this command in a terminal, then restart IEx.')
  );
  var commandRow = element('div', 'command-row');
  var commandCode = element('code', null, BRIDGE_UPDATE_COMMAND);
  var copyCommand = element('button', 'copy-button', 'Copy');
  copyCommand.type = 'button';
  copyCommand.title = 'Copy the wget command';
  commandRow.appendChild(commandCode);
  commandRow.appendChild(copyCommand);
  var copyStatus = element('div', 'copy-status');
  copyStatus.setAttribute('role', 'status');
  copyStatus.setAttribute('aria-live', 'polite');
  bridgeHelp.appendChild(commandRow);
  bridgeHelp.appendChild(copyStatus);

  var userscriptHelp = element('section', 'help-section');
  userscriptHelp.appendChild(element('h4', null, 'Update Tampermonkey'));
  userscriptHelp.appendChild(
    element(
      'p',
      null,
      'Open the published userscript. Tampermonkey will offer to install or update it.'
    )
  );
  var userscriptLink = element('a', 'help-link', 'Open tamperiex.user.js');
  userscriptLink.href = USERSCRIPT_URL;
  userscriptLink.target = '_blank';
  userscriptLink.rel = 'noopener noreferrer';
  userscriptHelp.appendChild(userscriptLink);

  var repositoryHelp = element('section', 'help-section');
  repositoryHelp.appendChild(element('h4', null, 'Project'));
  var repositoryLink = element('a', 'help-link', 'View the GitHub repository');
  repositoryLink.href = REPOSITORY_URL;
  repositoryLink.target = '_blank';
  repositoryLink.rel = 'noopener noreferrer';
  repositoryHelp.appendChild(repositoryLink);

  helpPanel.appendChild(helpHeading);
  helpPanel.appendChild(savedCallsHelp);
  helpPanel.appendChild(bridgeHelp);
  helpPanel.appendChild(userscriptHelp);
  helpPanel.appendChild(repositoryHelp);

  header.appendChild(title);
  headerActions.appendChild(settingsButton);
  headerActions.appendChild(helpButton);
  headerActions.appendChild(closeButton);
  header.appendChild(headerActions);
  blockerPanel.appendChild(blockerTitle);
  blockerPanel.appendChild(blockerMessage);
  blockerPanel.appendChild(blockerSearch);
  blockerPanel.appendChild(blockerStatus);
  blocker.appendChild(blockerPanel);
  dialog.appendChild(header);
  dialog.appendChild(content);
  dialog.appendChild(blocker);
  dialog.appendChild(settingsPanel);
  dialog.appendChild(helpPanel);
  overlay.appendChild(dialog);
  shadow.appendChild(overlay);

  function clearContent() {
    content.classList.remove('workspace-content');
    while (content.firstChild) content.removeChild(content.firstChild);
  }

  function openModal() {
    var currentFocus = shadow.activeElement || document.activeElement;
    focusBeforeOpen =
      currentFocus &&
      currentFocus !== document.body &&
      currentFocus !== document.documentElement &&
      currentFocus !== host
        ? currentFocus
        : null;
    popupIsOpen = true;
    launcher.setAttribute('aria-expanded', 'true');
    overlay.classList.remove('hidden');
  }

  function syncInertState() {
    var panelIsOpen = helpIsOpen || settingsIsOpen;
    content.inert = popupIsBlocked || panelIsOpen;
    blocker.inert = panelIsOpen;
  }

  function applyLauncherVisibility() {
    launcher.classList.toggle('hidden', !settings.showLauncher);
    launcher.setAttribute('aria-hidden', settings.showLauncher ? 'false' : 'true');
    launcherSettingInput.checked = settings.showLauncher;
  }

  function openHelp() {
    closeSettings(false);
    helpIsOpen = true;
    helpButton.setAttribute('aria-expanded', 'true');
    helpPanel.classList.remove('hidden');
    syncInertState();
    helpBack.focus();
  }

  function closeHelp(returnFocus) {
    helpIsOpen = false;
    helpButton.setAttribute('aria-expanded', 'false');
    helpPanel.classList.add('hidden');
    syncInertState();

    if (returnFocus) {
      if (popupIsBlocked) {
        blockerSearch.focus();
      } else {
        helpButton.focus();
      }
    }
  }

  function openSettings() {
    closeHelp(false);
    settingsIsOpen = true;
    launcherSettingInput.checked = settings.showLauncher;
    settingsStatus.textContent = '';
    settingsButton.setAttribute('aria-expanded', 'true');
    settingsPanel.classList.remove('hidden');
    syncInertState();
    launcherSettingInput.focus();
  }

  function closeSettings(returnFocus) {
    settingsIsOpen = false;
    settingsButton.setAttribute('aria-expanded', 'false');
    settingsPanel.classList.add('hidden');
    syncInertState();

    if (returnFocus) {
      if (popupIsBlocked) {
        blockerSearch.focus();
      } else {
        settingsButton.focus();
      }
    }
  }

  async function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch (_error) {
        // The fallback below also works without Clipboard permission.
      }
    }

    var textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    shadow.appendChild(textarea);
    textarea.select();

    var copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) throw new Error('Copy failed');
  }

  function closeModal() {
    var returnFocus = focusBeforeOpen;
    popupIsOpen = false;
    sessionGeneration += 1;
    verificationInFlight = false;
    stopMonitoring();
    activeBridge = null;
    closeHelp(false);
    closeSettings(false);
    hideBlocker();
    overlay.classList.add('hidden');
    launcher.setAttribute('aria-expanded', 'false');
    focusBeforeOpen = null;

    if (
      returnFocus &&
      returnFocus.isConnected &&
      returnFocus !== launcher &&
      typeof returnFocus.focus === 'function'
    ) {
      returnFocus.focus();
    } else if (settings.showLauncher) {
      launcher.focus();
    }
  }

  function sameIdentity(left, right) {
    return Boolean(
      left &&
        right &&
        left.id === right.id &&
        left.name === right.name &&
        left.port === right.port
    );
  }

  function manifestRevisionChanged(left, right) {
    return Boolean(
      left &&
        right &&
        (typeof left.manifestRevision === 'string' ||
          typeof right.manifestRevision === 'string') &&
        left.manifestRevision !== right.manifestRevision
    );
  }

  function stopMonitoring() {
    if (monitorTimer !== null) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }

    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function hideBlocker() {
    popupIsBlocked = false;
    syncInertState();
    blocker.classList.add('hidden');
    blockerSearch.disabled = false;
    blockerSearch.textContent = 'Find application';
    blockerStatus.textContent = '';
  }

  function blockPopup(message) {
    popupIsBlocked = true;
    stopMonitoring();
    content.inert = true;
    blockerTitle.textContent = 'Bridge unavailable';
    blockerMessage.textContent = message;
    blockerStatus.textContent = '';
    blockerSearch.disabled = false;
    blockerSearch.textContent = 'Find application';
    blocker.classList.remove('hidden');
    syncInertState();
    if (!helpIsOpen && !settingsIsOpen) blockerSearch.focus();
  }

  async function verifyActiveBridge() {
    if (
      !popupIsOpen ||
      popupIsBlocked ||
      !activeBridge ||
      verificationInFlight
    ) {
      return;
    }

    var expected = {
      id: activeBridge.id,
      name: activeBridge.name,
      port: activeBridge.port,
      manifestRevision: activeBridge.manifestRevision
    };
    var generation = sessionGeneration;
    verificationInFlight = true;

    try {
      var fresh = await probe(expected.port);

      if (
        !popupIsOpen ||
        generation !== sessionGeneration ||
        !sameIdentity(expected, readChoice())
      ) {
        return;
      }

      if (!sameIdentity(expected, fresh)) {
        throw new Error(
          'The saved port no longer matches application ' +
            expected.name +
            '.'
        );
      }

      if (manifestRevisionChanged(expected, fresh)) {
        var currentFilter = content.querySelector('.action-filter');
        var stable = await fetchStableManifest(fresh, generation);

        if (
          !popupIsOpen ||
          popupIsBlocked ||
          monitorTimer === null ||
          generation !== sessionGeneration ||
          !sameIdentity(expected, readChoice())
        ) {
          return;
        }

        if (!stable) return;

        await showWorkspace(stable.server, {
          manifest: stable.manifest,
          reloaded: true,
          filter: currentFilter ? currentFilter.value : ''
        });

        if (!popupIsOpen || generation !== sessionGeneration) return;

        activeBridge = stable.server;
      } else {
        activeBridge = fresh;
      }

      lastVerificationAt = Date.now();
    } catch (error) {
      if (
        popupIsOpen &&
        generation === sessionGeneration &&
        sameIdentity(expected, readChoice())
      ) {
        blockPopup(
          error && error.message
            ? error.message
            : 'Connection lost to ' +
                expected.name +
                ' on port ' +
                expected.port +
                '.'
        );
      }
    } finally {
      if (generation === sessionGeneration) {
        verificationInFlight = false;
      }
    }
  }

  function activateMonitoring(verifyImmediately) {
    if (!popupIsOpen || popupIsBlocked || !activeBridge) return;

    stopMonitoring();

    monitorTimer = setInterval(function () {
      verifyActiveBridge();
    }, VERIFY_INTERVAL);

    idleTimer = setTimeout(function () {
      stopMonitoring();
    }, IDLE_TIMEOUT);

    if (verifyImmediately) verifyActiveBridge();
  }

  function recordPopupActivity() {
    if (!popupIsOpen || popupIsBlocked || !activeBridge) return;

    var shouldVerify = monitorTimer === null;

    activateMonitoring(false);

    if (shouldVerify) verifyActiveBridge();
  }

  function showLoading(message) {
    clearContent();
    content.appendChild(element('div', 'loading', message));
  }

  function notice(message, isError) {
    return element('p', isError ? 'notice error' : 'notice', message);
  }

  function staleChoiceMessage(previous, bridges) {
    if (!previous) return null;

    var currentPort = bridges.find(function (bridge) {
      return bridge.port === previous.port;
    });

    var moved = bridges.find(function (bridge) {
      return bridge.id === previous.id && bridge.name === previous.name;
    });

    if (!moved) {
      moved = bridges.find(function (bridge) {
        return bridge.id === previous.id || bridge.name === previous.name;
      });
    }

    if (currentPort && !sameIdentity(currentPort, previous)) {
      if (moved) {
        return (
          'Port ' +
          previous.port +
          ' is now used by ' +
          currentPort.name +
          '. ' +
          previous.name +
          ' was found on port ' +
          moved.port +
          ' and remains preselected.'
        );
      }

      return (
        'Port ' +
        previous.port +
        ' no longer matches ' +
        previous.name +
        '. Select the application again.'
      );
    }

    if (moved) {
      return (
        previous.name +
        ' is now available on port ' +
        moved.port +
        '. Confirm the new mapping.'
      );
    }

    return (
      previous.name +
      ' is no longer available. Select an active application.'
    );
  }

  function preferredBridgeIndex(bridges, previous) {
    if (!previous) return 0;

    var exact = bridges.findIndex(function (bridge) {
      return bridge.id === previous.id && bridge.name === previous.name;
    });

    if (exact >= 0) return exact;

    var sameId = bridges.findIndex(function (bridge) {
      return bridge.id === previous.id;
    });

    if (sameId >= 0) return sameId;

    var sameName = bridges.findIndex(function (bridge) {
      return bridge.name === previous.name;
    });

    return sameName >= 0 ? sameName : 0;
  }

  async function confirmFreshBridge(bridge) {
    var fresh = await probe(bridge.port);

    if (!sameIdentity(fresh, bridge)) {
      throw new Error('The bridge identity changed during selection');
    }

    return fresh;
  }

  async function searchApplications(manual) {
    var generation = sessionGeneration + 1;
    sessionGeneration = generation;
    verificationInFlight = false;
    stopMonitoring();

    blocker.classList.remove('hidden');
    popupIsBlocked = true;
    content.inert = true;
    blockerTitle.textContent = 'Finding applications';
    blockerMessage.textContent =
      'This search runs only when you request it.';
    blockerSearch.disabled = true;
    blockerSearch.textContent = 'Searching…';
    blockerStatus.textContent =
      'Checking ports ' +
      FIRST_PORT +
      ' through ' +
      (FIRST_PORT + PORT_COUNT - 1) +
      '.';

    var previous = readChoice();
    var bridges = await scanBridges();

    if (!popupIsOpen || generation !== sessionGeneration) return;

    if (!bridges.length) {
      blockerTitle.textContent = 'No bridge found';
      blockerMessage.textContent =
        'No server responded within the configured range.';
      blockerSearch.disabled = false;
      blockerSearch.textContent = 'Search again';
      blockerStatus.textContent =
        'No active TamperIEx application was found.';
      return;
    }

    hideBlocker();
    showChooser(bridges, previous, Boolean(manual));
  }

  function showChooser(bridges, previous, manual) {
    stopMonitoring();
    activeBridge = null;
    hideBlocker();
    clearContent();
    title.textContent = 'Link application';

    if (!bridges.length) {
      blockPopup('No active TamperIEx application was found.');
      return;
    }

    var message = manual ? null : staleChoiceMessage(previous, bridges);
    if (message) content.appendChild(notice(message, false));

    var list = element('div', 'server-list');
    var preferredIndex = preferredBridgeIndex(bridges, previous);

    bridges.forEach(function (bridge, index) {
      var label = element('label', 'server-option');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'tamperiex-server';
      radio.value = String(index);

      radio.checked = index === preferredIndex;

      var identity = element('div');
      identity.appendChild(element('div', 'server-name', bridge.name));
      identity.appendChild(
        element('div', 'muted', bridge.id.slice(0, 12))
      );

      label.appendChild(radio);
      label.appendChild(identity);
      label.appendChild(element('span', 'server-port', ':' + bridge.port));
      list.appendChild(label);
    });

    content.appendChild(list);

    var confirm = element('button', 'button', 'Use this application');
    confirm.type = 'button';
    confirm.addEventListener('click', async function () {
      var checked = list.querySelector('input[type="radio"]:checked');
      if (!checked) return;

      var generation = sessionGeneration;
      confirm.disabled = true;

      try {
        var bridge = bridges[Number(checked.value)];
        var fresh = await confirmFreshBridge(bridge);

        if (!popupIsOpen || generation !== sessionGeneration) return;

        saveChoice(fresh);
        activeBridge = fresh;
        lastVerificationAt = Date.now();
        await showWorkspace(fresh);

        if (!popupIsOpen || generation !== sessionGeneration) return;

        activateMonitoring(false);
      } catch (error) {
        if (!popupIsOpen || generation !== sessionGeneration) return;

        content.insertBefore(notice(error.message, true), list);
        confirm.disabled = false;
      }
    });

    content.appendChild(confirm);
  }

  function createArgumentField(argument) {
    var wrapper = element('div', 'field');
    var inputId = 'tamperiex-argument-' + fieldSequence;
    fieldSequence += 1;
    var label = element(
      'label',
      'field-label',
      argument.label || argument.name
    );
    label.htmlFor = inputId;
    wrapper.appendChild(label);

    var input;
    var hasDefault = Object.prototype.hasOwnProperty.call(argument, 'default');

    if (argument.widget === 'select' && Array.isArray(argument.options)) {
      input = document.createElement('select');
      input.id = inputId;

      argument.options.forEach(function (optionDefinition) {
        var option = document.createElement('option');
        option.value = String(optionDefinition.value);
        option.textContent =
          optionDefinition.label === undefined
            ? String(optionDefinition.value)
            : String(optionDefinition.label);
        input.appendChild(option);
      });

      if (hasDefault) input.value = String(argument.default);
      wrapper.appendChild(input);
    } else if (argument.widget === 'toggle' || argument.type === 'boolean') {
      var toggle = element('div', 'toggle-row');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = inputId;
      input.checked = hasDefault ? Boolean(argument.default) : false;
      toggle.appendChild(input);
      toggle.appendChild(
        element('span', 'toggle-state', input.checked ? 'Enabled' : 'Disabled')
      );
      input.addEventListener('change', function () {
        toggle.lastChild.textContent = input.checked ? 'Enabled' : 'Disabled';
      });
      wrapper.appendChild(toggle);
    } else {
      input = document.createElement('input');
      input.id = inputId;
      input.required = true;

      if (
        argument.widget === 'number' ||
        ['integer', 'float', 'number'].indexOf(argument.type) !== -1
      ) {
        input.type = 'number';
        ['min', 'max', 'step'].forEach(function (attribute) {
          if (argument[attribute] !== undefined) {
            input.setAttribute(attribute, String(argument[attribute]));
          }
        });
      } else {
        input.type = 'text';
      }

      if (hasDefault) input.value = String(argument.default);
      if (argument.placeholder !== undefined) {
        input.placeholder = String(argument.placeholder);
      }

      wrapper.appendChild(input);
    }

    if (argument.description) {
      wrapper.appendChild(element('div', 'muted', argument.description));
    }

    return {
      node: wrapper,
      encodedValue: function () {
        var value =
          argument.type === 'boolean'
            ? input.checked
              ? 'true'
              : 'false'
            : input.value;

        return argument.type + ':' + value;
      }
    };
  }

  function encodedArgumentType(value) {
    var separator = value.indexOf(':');
    return separator < 0 ? '' : value.slice(0, separator);
  }

  function encodedArgumentValue(value) {
    var separator = value.indexOf(':');
    return separator < 0 ? value : value.slice(separator + 1);
  }

  function matchingApi(manifest, savedCall) {
    return manifest.find(function (api) {
      return Boolean(
        api.visible !== false &&
          api.name === savedCall.functionName &&
          api.arguments.length === savedCall.arguments.length &&
          api.arguments.every(function (argument, index) {
            return argument.type === encodedArgumentType(savedCall.arguments[index]);
          })
      );
    });
  }

  function formatSavedArgument(argument, encodedValue) {
    var value = encodedArgumentValue(encodedValue);

    if (argument.widget === 'select' && Array.isArray(argument.options)) {
      var selected = argument.options.find(function (option) {
        return String(option.value) === value;
      });

      if (selected && selected.label !== undefined) value = String(selected.label);
    } else if (argument.type === 'atom') {
      value = ':' + value;
    } else if (argument.type === 'string') {
      value = '"' + value + '"';
    }

    return (argument.label || argument.name) + '=' + value;
  }

  function callBody(functionName, encodedArguments) {
    var body = new URLSearchParams();
    body.set('function', functionName);
    encodedArguments.forEach(function (argument) {
      body.append('arg', argument);
    });
    return body;
  }

  async function executeCall(
    server,
    functionName,
    encodedArguments,
    submit,
    result
  ) {
    var generation = sessionGeneration;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    result.className = 'result visible';
    result.textContent = 'Running…';

    try {
      await confirmFreshBridge(server);

      if (
        !popupIsOpen ||
        generation !== sessionGeneration ||
        !sameIdentity(server, readChoice())
      ) {
        throw new Error('The application mapping changed before execution');
      }
    } catch (error) {
      if (!popupIsOpen || generation !== sessionGeneration) return;

      result.textContent = error.message;
      result.classList.add('failure');
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      blockPopup(
        'The mapping to ' +
          server.name +
          ' is no longer valid on port ' +
          server.port +
          '.'
      );
      return;
    }

    try {
      var response = await request({
        method: 'POST',
        url: bridgeUrl(server.port, '/call'),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        data: callBody(functionName, encodedArguments).toString()
      });

      result.textContent = response.responseText || '(no value returned)';

      if (response.status < 200 || response.status >= 300) {
        result.classList.add('failure');
      }
    } catch (error) {
      result.textContent = error.message;
      result.classList.add('failure');
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  }

  function createActionRow(server, api) {
    var row = element('form', 'action-row');
    row.dataset.apiKey =
      api.name + '/' + String((api.arguments || []).length);
    var metadata = element('div', 'action-meta');
    var heading = element('h3', null, api.label || api.name);
    metadata.appendChild(heading);
    metadata.appendChild(
      element(
        'code',
        'signature',
        api.name + '/' + String((api.arguments || []).length)
      )
    );

    if (api.description) {
      metadata.appendChild(element('p', 'description', api.description));
    }

    row.appendChild(metadata);
    row.dataset.search = [api.label, api.name, api.description]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();

    var fieldsNode = element('div', 'fields');
    var fields = (api.arguments || []).map(function (argument, index) {
      var field = createArgumentField(argument, index);
      fieldsNode.appendChild(field.node);
      return field;
    });

    row.appendChild(fieldsNode);

    var submit = element('button', 'button action-run', 'Run');
    submit.type = 'submit';
    var result = element('pre', 'result');

    row.appendChild(submit);
    row.appendChild(result);

    row.addEventListener('submit', async function (event) {
      event.preventDefault();

      if (!row.reportValidity()) return;

      await executeCall(
        server,
        api.name,
        fields.map(function (field) {
          return field.encodedValue();
        }),
        submit,
        result
      );
    });

    return row;
  }

  function createPresetBuilder(server, manifest, onSaved, onClosed) {
    var availableApis = manifest.filter(function (api) {
      return api.visible !== false;
    });
    var form = element('form', 'preset-builder hidden');

    var functionField = element('div', 'field');
    var functionLabel = element('label', 'field-label', 'Function');
    var functionSelect = document.createElement('select');
    var functionSelectId = 'tamperiex-preset-function-' + fieldSequence;
    fieldSequence += 1;
    functionSelect.id = functionSelectId;
    functionSelect.required = true;
    functionLabel.htmlFor = functionSelectId;

    availableApis.forEach(function (api, index) {
      var option = document.createElement('option');
      option.value = String(index);
      option.textContent =
        (api.label || api.name) +
        ' · ' +
        api.name +
        '/' +
        api.arguments.length;
      functionSelect.appendChild(option);
    });
    functionField.appendChild(functionLabel);
    functionField.appendChild(functionSelect);

    var nameField = element('div', 'field');
    var nameLabel = element('label', 'field-label', 'Preset name');
    var nameInput = document.createElement('input');
    var nameInputId = 'tamperiex-preset-name-' + fieldSequence;
    fieldSequence += 1;
    nameInput.id = nameInputId;
    nameInput.type = 'text';
    nameInput.required = true;
    nameInput.maxLength = 80;
    nameInput.placeholder = 'E.g. Enable Strasbourg';
    nameLabel.htmlFor = nameInputId;
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);

    var argumentFields = element('div', 'preset-fields');
    var fields = [];

    function selectedApi() {
      return availableApis[Number(functionSelect.value)];
    }

    function renderArguments() {
      while (argumentFields.firstChild) {
        argumentFields.removeChild(argumentFields.firstChild);
      }

      var api = selectedApi();
      fields = [];

      if (!api || !api.arguments.length) {
        argumentFields.appendChild(
          element('span', 'preset-fields-empty', 'This function has no arguments.')
        );
        return;
      }

      fields = api.arguments.map(function (argument) {
        var field = createArgumentField(argument);
        argumentFields.appendChild(field.node);
        return field;
      });
    }

    var actions = element('div', 'preset-actions');
    var cancel = element('button', 'button secondary preset-cancel', 'Cancel');
    cancel.type = 'button';
    var save = element('button', 'button', 'Create preset');
    save.type = 'submit';
    actions.appendChild(cancel);
    actions.appendChild(save);

    form.appendChild(functionField);
    form.appendChild(nameField);
    form.appendChild(argumentFields);
    form.appendChild(actions);

    function close() {
      form.classList.add('hidden');
      nameInput.setCustomValidity('');
      if (onClosed) onClosed();
    }

    function open() {
      functionSelect.value = '0';
      nameInput.value = '';
      nameInput.setCustomValidity('');
      renderArguments();
      form.classList.remove('hidden');
      functionSelect.focus();
    }

    functionSelect.addEventListener('change', renderArguments);
    nameInput.addEventListener('input', function () {
      nameInput.setCustomValidity('');
    });
    cancel.addEventListener('click', close);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;

      var api = selectedApi();
      var name = nameInput.value.trim();

      if (!api) return;

      if (!name) {
        nameInput.setCustomValidity('Give this preset a name.');
        nameInput.reportValidity();
        return;
      }

      var savedCalls = readSavedCalls(server);
      var duplicate = savedCalls.some(function (savedCall) {
        return savedCall.name.toLocaleLowerCase() === name.toLocaleLowerCase();
      });

      if (duplicate) {
        nameInput.setCustomValidity('A preset with this name already exists in this project.');
        nameInput.reportValidity();
        return;
      }

      savedCalls.push({
        id: localId(),
        name: name,
        functionName: api.name,
        apiLabel: api.label || api.name,
        arguments: fields.map(function (field) {
          return field.encodedValue();
        })
      });
      writeSavedCalls(server, savedCalls);
      close();
      onSaved();
    });

    return {
      node: form,
      open: open,
      close: close,
      isOpen: function () {
        return !form.classList.contains('hidden');
      }
    };
  }

  function createSavedCallRow(server, savedCall, manifest, onRemoved) {
    var api = matchingApi(manifest, savedCall);
    var row = element(
      'div',
      api ? 'saved-call' : 'saved-call unavailable'
    );
    var metadata = element('div', 'saved-call-meta');
    metadata.appendChild(element('strong', 'saved-call-title', savedCall.name));

    var details = savedCall.functionName + '/' + savedCall.arguments.length;

    if (api && api.arguments.length) {
      details +=
        ' · ' +
        api.arguments
          .map(function (argument, index) {
            return formatSavedArgument(argument, savedCall.arguments[index]);
          })
          .join(' · ');
    }

    var detailNode = element('code', 'saved-call-detail', details);
    detailNode.title = details;
    metadata.appendChild(detailNode);

    if (!api) {
      metadata.appendChild(
        element(
          'span',
          'saved-warning',
          'Function missing, hidden, or using a different signature.'
        )
      );
    }

    var remove = element('button', 'icon-button saved-delete', '×');
    remove.type = 'button';
    remove.title = 'Delete this preset';
    remove.setAttribute('aria-label', 'Delete ' + savedCall.name);
    var removalTimer = null;

    remove.addEventListener('click', function () {
      if (remove.dataset.confirm !== 'true') {
        remove.dataset.confirm = 'true';
        remove.classList.add('confirm');
        remove.textContent = '?';
        remove.title = 'Click again to confirm deletion';
        removalTimer = setTimeout(function () {
          remove.dataset.confirm = 'false';
          remove.classList.remove('confirm');
          remove.textContent = '×';
          remove.title = 'Delete this preset';
        }, 2500);
        return;
      }

      if (removalTimer !== null) clearTimeout(removalTimer);
      writeSavedCalls(
        server,
        readSavedCalls(server).filter(function (candidate) {
          return candidate.id !== savedCall.id;
        })
      );
      onRemoved();
    });

    var run = element('button', 'button saved-run', 'Run');
    run.type = 'button';
    run.disabled = !api;
    if (!api) run.title = 'This preset no longer matches the current manifest';
    var result = element('pre', 'result');

    run.addEventListener('click', function () {
      executeCall(
        server,
        savedCall.functionName,
        savedCall.arguments,
        run,
        result
      );
    });

    row.appendChild(metadata);
    row.appendChild(remove);
    row.appendChild(run);
    row.appendChild(result);
    return row;
  }

  function renderSavedCalls(server, manifest, container, countNode) {
    while (container.firstChild) container.removeChild(container.firstChild);

    var savedCalls = readSavedCalls(server);
    countNode.textContent = String(savedCalls.length);

    if (!savedCalls.length) {
      var empty = element('div', 'empty');
      empty.appendChild(element('strong', null, 'No presets'));
      empty.appendChild(
        document.createTextNode(
          ' Use “New preset” to choose a function and prepare its arguments.'
        )
      );
      container.appendChild(empty);
      return;
    }

    savedCalls.forEach(function (savedCall) {
      container.appendChild(
        createSavedCallRow(server, savedCall, manifest, function () {
          renderSavedCalls(server, manifest, container, countNode);
        })
      );
    });
  }

  async function fetchManifest(server) {
    var response = await request({
      url: bridgeUrl(server.port, '/api')
    });

    if (response.status !== 200) {
      var responseDetails = String(response.responseText || '').trim();
      var suffix = responseDetails ? ' — ' + responseDetails.slice(0, 800) : '';

      throw new Error(
        'The bridge is responding, but its API returned HTTP ' +
          response.status +
          suffix
      );
    }

    var manifest;

    try {
      manifest = JSON.parse(response.responseText);
    } catch (_error) {
      throw new Error('The bridge is responding, but /api did not return valid JSON');
    }

    if (!Array.isArray(manifest)) {
      throw new Error('The bridge is responding, but its /api manifest is not a list');
    }

    manifest.forEach(function (api, apiIndex) {
      if (!api || typeof api !== 'object' || Array.isArray(api)) {
        throw new Error('Invalid action at manifest index ' + apiIndex);
      }

      if (typeof api.name !== 'string' || !Array.isArray(api.arguments)) {
        throw new Error(
          'Invalid action at manifest index ' +
            apiIndex +
            ': missing name or arguments'
        );
      }
    });

    return {
      manifest: manifest,
      manifestRevision: responseHeader(
        response,
        'X-TamperIEx-Manifest-Revision'
      )
    };
  }

  function automaticRefreshStillActive(server, generation) {
    return Boolean(
      popupIsOpen &&
        !popupIsBlocked &&
        generation === sessionGeneration &&
        monitorTimer !== null &&
        sameIdentity(server, activeBridge) &&
        sameIdentity(server, readChoice())
    );
  }

  async function fetchStableManifest(server, generation) {
    var snapshot;

    try {
      snapshot = await fetchManifest(server);
    } catch (_error) {
      // The module may be between two compilations. Keep the current interface
      // in place and retry on the next verification.
      return null;
    }

    if (
      !automaticRefreshStillActive(server, generation) ||
      manifestRevisionChanged(server, snapshot)
    ) {
      return null;
    }

    var after = await probe(server.port);

    if (!sameIdentity(server, after)) {
      throw new Error('The bridge identity changed during reload');
    }

    if (
      manifestRevisionChanged(server, after) ||
      manifestRevisionChanged(snapshot, after)
    ) {
      return null;
    }

    return { server: after, manifest: snapshot.manifest };
  }

  async function showWorkspace(server, options) {
    options = options || {};
    activeBridge = server;
    hideBlocker();
    clearContent();
    content.classList.add('workspace-content');
    title.textContent = 'TamperIEx';

    var workspaceBar = element('div', 'workspace-bar');
    var selectedServer = element('div', 'server-select');
    selectedServer.appendChild(element('span', 'server-primary', server.name));
    var context = element(
      'span',
      'context',
      '127.0.0.1:' + server.port + ' · web :' + applicationPort() + ' · loading…'
    );
    selectedServer.appendChild(context);

    var choose = element('button', 'button secondary', 'Change');
    choose.type = 'button';
    choose.addEventListener('click', function () {
      searchApplications(true);
    });

    workspaceBar.appendChild(selectedServer);
    workspaceBar.appendChild(choose);
    content.appendChild(workspaceBar);

    var tabs = element('div', 'workspace-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Sections TamperIEx');

    var functionsTab = element('button', 'tab');
    functionsTab.type = 'button';
    functionsTab.id = '__tamperiex_functions_tab';
    functionsTab.setAttribute('role', 'tab');
    functionsTab.setAttribute('aria-controls', '__tamperiex_functions_panel');
    functionsTab.appendChild(document.createTextNode('Functions'));
    var functionsTabCount = element('span', 'tab-count', '0');
    functionsTab.appendChild(functionsTabCount);

    var savedTab = element('button', 'tab');
    savedTab.type = 'button';
    savedTab.id = '__tamperiex_saved_tab';
    savedTab.setAttribute('role', 'tab');
    savedTab.setAttribute('aria-controls', '__tamperiex_saved_panel');
    savedTab.appendChild(document.createTextNode('Calls'));
    var savedTabCount = element(
      'span',
      'tab-count',
      String(readSavedCalls(server).length)
    );
    savedTab.appendChild(savedTabCount);

    tabs.appendChild(functionsTab);
    tabs.appendChild(savedTab);
    content.appendChild(tabs);

    var panels = element('div', 'workspace-panels');
    var functionsPanel = element('section', 'tab-panel');
    functionsPanel.id = '__tamperiex_functions_panel';
    functionsPanel.setAttribute('role', 'tabpanel');
    functionsPanel.setAttribute('aria-labelledby', functionsTab.id);
    var savedPanel = element('section', 'tab-panel');
    savedPanel.id = '__tamperiex_saved_panel';
    savedPanel.setAttribute('role', 'tabpanel');
    savedPanel.setAttribute('aria-labelledby', savedTab.id);

    var filterTools = element('div', 'filter-tools');
    var actionFilter = document.createElement('input');
    actionFilter.type = 'search';
    actionFilter.className = 'action-filter';
    actionFilter.placeholder = 'Filter functions…';
    actionFilter.setAttribute('aria-label', 'Filter functions');
    actionFilter.title = 'Shortcut: /';
    actionFilter.value = options.filter || '';
    var filterCount = element('span', 'filter-count', '0');
    filterTools.appendChild(actionFilter);
    filterTools.appendChild(filterCount);

    var actions = element('div', 'actions');
    actions.appendChild(element('div', 'loading', 'Loading functions…'));
    functionsPanel.appendChild(filterTools);
    functionsPanel.appendChild(actions);

    var savedHead = element('div', 'saved-head');
    savedHead.appendChild(element('strong', null, 'Presets'));
    var newPreset = element('button', 'button', '＋ New preset');
    newPreset.type = 'button';
    newPreset.disabled = true;
    newPreset.setAttribute('aria-controls', '__tamperiex_preset_builder');
    newPreset.setAttribute('aria-expanded', 'false');
    savedHead.appendChild(newPreset);
    var savedList = element('div', 'saved-list');
    savedList.appendChild(element('div', 'loading', 'Loading presets…'));
    savedPanel.appendChild(savedHead);
    savedPanel.appendChild(savedList);

    var presetBuilder = null;

    newPreset.addEventListener('click', function () {
      if (!presetBuilder) return;

      if (presetBuilder.isOpen()) {
        presetBuilder.close();
        newPreset.focus();
      } else {
        presetBuilder.open();
        newPreset.setAttribute('aria-expanded', 'true');
      }
    });

    panels.appendChild(functionsPanel);
    panels.appendChild(savedPanel);
    content.appendChild(panels);

    function activateTab(tabName, focusTab) {
      var showSaved = tabName === 'saved';
      functionsTab.setAttribute('aria-selected', showSaved ? 'false' : 'true');
      savedTab.setAttribute('aria-selected', showSaved ? 'true' : 'false');
      functionsTab.tabIndex = showSaved ? -1 : 0;
      savedTab.tabIndex = showSaved ? 0 : -1;
      functionsPanel.hidden = showSaved;
      savedPanel.hidden = !showSaved;
      writeActiveTab(server, showSaved ? 'saved' : 'functions');

      if (focusTab) (showSaved ? savedTab : functionsTab).focus();
    }

    functionsTab.addEventListener('click', function () {
      activateTab('functions', false);
    });
    savedTab.addEventListener('click', function () {
      activateTab('saved', false);
    });
    tabs.addEventListener('keydown', function (event) {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) === -1) {
        return;
      }

      event.preventDefault();
      var target =
        event.key === 'ArrowLeft' || event.key === 'Home'
          ? 'functions'
          : 'saved';
      activateTab(target, true);
    });
    activateTab(readActiveTab(server), false);

    actionFilter.addEventListener('input', function () {
      var query = actionFilter.value.trim().toLocaleLowerCase();
      var rows = actions.querySelectorAll('.action-row');
      var visibleCount = 0;

      Array.prototype.forEach.call(rows, function (row) {
        var visible = !query || row.dataset.search.indexOf(query) !== -1;
        row.hidden = !visible;
        if (visible) visibleCount += 1;
      });

      filterCount.textContent =
        visibleCount === rows.length
          ? String(rows.length)
          : String(visibleCount) + '/' + String(rows.length);
    });

    try {
      var generation = sessionGeneration;
      var manifest = options.manifest;

      if (!manifest) {
        manifest = (await fetchManifest(server)).manifest;
      }

      if (
        !popupIsOpen ||
        generation !== sessionGeneration ||
        !sameIdentity(server, readChoice())
      ) {
        return;
      }

      activeBridge = server;
      lastVerificationAt = Date.now();

      while (actions.firstChild) actions.removeChild(actions.firstChild);

      var visibleManifest = manifest.filter(function (api) {
        return api.visible !== false;
      });

      filterTools.classList.toggle('hidden', visibleManifest.length < 4);

      context.textContent =
        '127.0.0.1:' +
        server.port +
        ' · web :' +
        applicationPort() +
        (options.reloaded ? ' · API reloaded' : ' · connected');
      functionsTabCount.textContent = String(visibleManifest.length);
      filterCount.textContent = String(visibleManifest.length);

      presetBuilder = createPresetBuilder(
        server,
        manifest,
        function () {
          renderSavedCalls(server, manifest, savedList, savedTabCount);
          newPreset.setAttribute('aria-expanded', 'false');
          newPreset.focus();
        },
        function () {
          newPreset.setAttribute('aria-expanded', 'false');
          newPreset.focus();
        }
      );
      presetBuilder.node.id = '__tamperiex_preset_builder';
      savedPanel.insertBefore(presetBuilder.node, savedList);
      newPreset.disabled = visibleManifest.length === 0;
      renderSavedCalls(server, manifest, savedList, savedTabCount);

      if (!visibleManifest.length) {
        actions.appendChild(
          element('div', 'empty', 'This bridge exposes no visible functions.')
        );
        return;
      }

      visibleManifest.forEach(function (api) {
        actions.appendChild(createActionRow(server, api));
      });

      if (actionFilter.value && visibleManifest.length >= 4) {
        actionFilter.dispatchEvent(new Event('input'));
      } else if (visibleManifest.length < 4) {
        actionFilter.value = '';
      }
    } catch (error) {
      if (
        !popupIsOpen ||
        generation !== sessionGeneration ||
        !sameIdentity(server, readChoice())
      ) {
        return;
      }

      while (actions.firstChild) actions.removeChild(actions.firstChild);
      context.textContent =
        '127.0.0.1:' + server.port + ' · API loading error';
      functionsTabCount.textContent = '!';
      renderSavedCalls(server, [], savedList, savedTabCount);
      actions.appendChild(
        notice(
          (error && error.message
            ? error.message
            : 'Unknown error while loading the API') +
            '. The bridge mapping has been preserved.',
          true
        )
      );

      var retry = element('button', 'button', 'Retry API loading');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        showWorkspace(server);
      });
      actions.appendChild(retry);
    }
  }

  async function openBridge() {
    var generation = sessionGeneration + 1;
    sessionGeneration = generation;
    verificationInFlight = false;

    openModal();
    stopMonitoring();
    hideBlocker();
    activeBridge = null;
    title.textContent = 'TamperIEx';
    showLoading('Checking the saved application mapping…');

    var previous = readChoice();

    if (!previous) {
      blockPopup(
        'No application is linked to web port ' +
          applicationPort() +
          '.'
      );
      return;
    }

    try {
      var fresh = await probe(previous.port);

      if (
        !popupIsOpen ||
        generation !== sessionGeneration
      ) {
        return;
      }

      if (!sameIdentity(previous, fresh)) {
        blockPopup(
          'Port ' +
            previous.port +
            ' no longer matches application ' +
            previous.name +
            '.'
        );
        return;
      }

      activeBridge = fresh;
      lastVerificationAt = Date.now();
      await showWorkspace(fresh);

      if (!popupIsOpen || generation !== sessionGeneration) return;

      activateMonitoring(false);
    } catch (error) {
      if (popupIsOpen && generation === sessionGeneration) {
        blockPopup(
          'Application ' +
            previous.name +
            ' is no longer responding on port ' +
            previous.port +
            '.'
        );
      }
    }
  }

  launcher.addEventListener('click', openBridge);
  blockerSearch.addEventListener('click', function () {
    searchApplications(false);
  });
  settingsButton.addEventListener('click', function () {
    if (settingsIsOpen) {
      closeSettings(true);
    } else {
      openSettings();
    }
  });
  settingsBack.addEventListener('click', function () {
    closeSettings(true);
  });
  launcherSettingInput.addEventListener('change', function () {
    settings.showLauncher = launcherSettingInput.checked;
    saveSettings();
    applyLauncherVisibility();
    settingsStatus.textContent = settings.showLauncher
      ? 'The IEx button is now displayed on pages.'
      : 'The IEx button is hidden. The ⌘K shortcut remains active.';
  });
  helpButton.addEventListener('click', function () {
    if (helpIsOpen) {
      closeHelp(true);
    } else {
      openHelp();
    }
  });
  helpBack.addEventListener('click', function () {
    closeHelp(true);
  });
  copyCommand.addEventListener('click', async function () {
    copyCommand.disabled = true;
    copyStatus.textContent = '';

    try {
      await copyText(BRIDGE_UPDATE_COMMAND);
      copyStatus.textContent = 'Command copied.';
    } catch (_error) {
      copyStatus.textContent =
        'Copy failed: select the command above.';
    } finally {
      copyCommand.disabled = false;
    }
  });
  closeButton.addEventListener('click', closeModal);
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeModal();
  });
  ['pointerdown', 'keydown', 'input', 'change'].forEach(function (eventName) {
    overlay.addEventListener(eventName, recordPopupActivity);
  });
  window.addEventListener('keydown', function (event) {
    var commandK =
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      String(event.key).toLowerCase() === 'k';

    if (commandK) {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (!event.repeat && !popupIsOpen) openBridge();
      return;
    }

    if (event.key === 'Escape' && popupIsOpen) {
      event.preventDefault();
      event.stopPropagation();

      if (settingsIsOpen) {
        closeSettings(true);
      } else if (helpIsOpen) {
        closeHelp(true);
      } else {
        var presetEditor = content.querySelector('.preset-builder:not(.hidden)');

        if (presetEditor) {
          var cancelPreset = presetEditor.querySelector('.preset-cancel');
          if (cancelPreset) cancelPreset.click();
        } else {
          closeModal();
        }
      }
      return;
    }

    var focused = shadow.activeElement;
    var editing =
      focused &&
      ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(focused.tagName) !== -1;

    if (
      event.key === '/' &&
      popupIsOpen &&
      !popupIsBlocked &&
      !helpIsOpen &&
      !settingsIsOpen &&
      !editing
    ) {
      var filter = content.querySelector('.action-filter:not(.hidden)');

      if (filter && filter.offsetParent !== null) {
        event.preventDefault();
        filter.focus();
      }
    }
  }, true);
})();
