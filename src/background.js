/* Feedback for LLM — background script.
 *
 * - Toolbar click → tell the content script to toggle the pill.
 * - Content scripts report their open-remark count → toolbar badge.
 *
 * Every delivery stage logs with an "ffab:" prefix (about:debugging → Inspect
 * → Console), and a failed click flashes a code on the toolbar badge so a
 * failure is visible without devtools:
 *   E1 = content.js injected, but the resent toggle still went unanswered
 *   E2 = the page refused the content script (about:, PDF viewer, AMO, …)
 */

/** A diagnostic code on the toolbar badge for ~5s, then back to the count. */
function flashError(code) {
  browser.browserAction.setBadgeText({ text: code });
  browser.browserAction.setBadgeBackgroundColor({ color: "#c02b2b" });
  setTimeout(() => browser.browserAction.setBadgeText({ text: "" }), 5000);
}

browser.browserAction.onClicked.addListener(async (tab) => {
  try {
    await browser.tabs.sendMessage(tab.id, { type: "ffab:toggle" });
    console.error(`ffab: toggle delivered (tab ${tab.id}, ${tab.url})`);
  } catch (e1) {
    // The content script is not listening yet: the tab is still loading (it
    // runs at document_idle), a lazily restored session tab has not finished,
    // or the tab kept a pre-update instance whose listener died with the old
    // extension version. Inject the content script now (its teardown handshake
    // retires any previous instance) and deliver the toggle it missed.
    console.error(`ffab: no listener (tab ${tab.id}) — ${e1.message}; injecting content.js`);
    try {
      await browser.tabs.executeScript(tab.id, {
        file: "/content.js",
        runAt: "document_idle",
      });
      console.error(`ffab: content.js injected (tab ${tab.id})`);
      try {
        await browser.tabs.sendMessage(tab.id, { type: "ffab:toggle" });
        console.error("ffab: toggle delivered after injection");
      } catch (e2) {
        console.error(`ffab: resend after injection failed — ${e2.message}`);
        flashError("E1");
      }
    } catch (e2) {
      console.error(`ffab: injection failed (tab ${tab.id}, ${tab.url}) — ${e2.message}`);
      flashError("E2");
    }
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ffab:badge" && typeof msg.count === "number") {
    browser.browserAction.setBadgeText({ text: msg.count ? String(msg.count) : "" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#4f46e5" });
  }
});
