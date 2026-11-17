// Yodayo Preset - toolbar icon and keyboard shortcut open/close the panel on the current tab.
function toggle(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'toggle' }).catch(() => {
    /* not a Yodayo tab, or the page has not been refreshed since installing */
  });
}

chrome.action.onClicked.addListener((tab) => toggle(tab && tab.id));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-panel') return;
  if (tab && tab.id != null) {
    toggle(tab.id);
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
    if (t) toggle(t.id);
  });
});
