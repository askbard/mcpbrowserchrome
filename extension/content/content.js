// Lightweight content script. Most page interaction happens via
// chrome.scripting.executeScript from the service worker, but this script
// surfaces a small floating button that opens the side panel and lets the
// user grab the current selection into the chat.

(() => {
  if (window.__mcpbrowserchrome_loaded) return;
  window.__mcpbrowserchrome_loaded = true;

  // Bridge "ask about selection" via keyboard: Ctrl+Shift+L → push selection
  // text into the side-panel input box.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
      const sel = window.getSelection()?.toString() || "";
      if (!sel) return;
      chrome.runtime.sendMessage({
        type: "seed-input",
        text: `About this selection on ${location.href}:\n\n"${sel}"`
      });
    }
  });
})();
