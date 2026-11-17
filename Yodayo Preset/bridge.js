// Yodayo Preset - storage bridge (runs in the extension's isolated world).
// The page script (inject.js) cannot use chrome.storage, so it talks to this file with postMessage.
(() => {
  'use strict';
  const TAG_PAGE = 'ysp2-page';
  const TAG_EXT = 'ysp2-ext';

  let data = null; // everything we have stored (only ysp2_* keys)

  const send = (msg) => {
    try {
      window.postMessage(Object.assign({ source: TAG_EXT }, msg), location.origin);
    } catch (e) {}
  };

  chrome.storage.local
    .get(null)
    .then((all) => {
      data = all || {};
      send({ type: 'init', data });
    })
    .catch(() => {
      data = {};
      send({ type: 'init', data });
    });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.source !== TAG_PAGE) return;
    if (m.type === 'hello') {
      if (data) send({ type: 'init', data });
    } else if (m.type === 'set' && typeof m.key === 'string' && m.key.indexOf('ysp2_') === 0) {
      if (data) data[m.key] = m.value;
      try {
        chrome.storage.local.set({ [m.key]: m.value }).catch(() => {});
      } catch (err) {}
    }
  });

  // Toolbar icon / keyboard shortcut -> open or close the panel
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle') send({ type: 'toggle' });
  });
})();
