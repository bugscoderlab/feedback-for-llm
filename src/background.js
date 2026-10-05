/* Feedback for LLM — background script.
 *
 * - Toolbar click → tell the content script to toggle the drawer.
 * - Content scripts report their open-remark count → toolbar badge.
 */
browser.browserAction.onClicked.addListener(async (tab) => {
  try {
    await browser.tabs.sendMessage(tab.id, { type: "ffab:toggle" });
  } catch {
    // content script not available on this page (e.g. about:) — ignore
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ffab:badge" && typeof msg.count === "number") {
    browser.browserAction.setBadgeText({ text: msg.count ? String(msg.count) : "" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#4f46e5" });
  }
});
