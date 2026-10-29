/* Feedback for LLM — background script.
 *
 * - Toolbar click → tell the content script to toggle the pill.
 * - Content scripts report their open-remark count → toolbar badge.
 */
browser.browserAction.onClicked.addListener(async (tab) => {
  try {
    await browser.tabs.sendMessage(tab.id, { type: "ffab:toggle" });
  } catch {
    // The content script is not listening yet: the tab is still loading (it
    // runs at document_idle) or a lazily restored session tab has not finished.
    // Dropping the click here is the "pill never appears" bug — inject the
    // content script now (its __ffabLoaded guard makes this safe on a tab that
    // raced us) and deliver the toggle it missed.
    try {
      await browser.tabs.executeScript(tab.id, {
        file: "/content.js",
        runAt: "document_idle",
      });
      await browser.tabs.sendMessage(tab.id, { type: "ffab:toggle" });
    } catch {
      // Pages that can never host content scripts — about:, addons.mozilla.org,
      // the built-in PDF viewer. The pill cannot exist there; fail quietly.
    }
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ffab:badge" && typeof msg.count === "number") {
    browser.browserAction.setBadgeText({ text: msg.count ? String(msg.count) : "" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#4f46e5" });
  }
});
