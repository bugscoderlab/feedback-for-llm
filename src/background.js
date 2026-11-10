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

// Per-tab armed-pick state, mirrored from the top frame for subframe relays:
// a parent page cannot message a cross-origin child, so relays pull the state
// from here, and their picks round-trip through here up to the top frame.
const pickStates = new Map();

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "ffab:badge" && typeof msg.count === "number") {
    browser.browserAction.setBadgeText({ text: msg.count ? String(msg.count) : "" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#4f46e5" });
  }
  if (msg.type === "ffab:pick-state" && sender.tab) {
    pickStates.set(sender.tab.id, { active: msg.active, mode: msg.mode });
    return;
  }
  if (msg.type === "ffab:pick-state?" && sender.tab) {
    return Promise.resolve(pickStates.get(sender.tab.id) ?? { active: false });
  }
  if (msg.type === "ffab:relay-pick" && sender.tab) {
    // a subframe's pick — deliver it to the top frame's UI
    browser.tabs.sendMessage(sender.tab.id, msg, { frameId: 0 }).catch(() => {});
    return;
  }
});

browser.tabs.onRemoved.addListener((tabId) => pickStates.delete(tabId));

/* Local files: Firefox never lets extension content into file:// documents —
 * no permission grants access (verified empirically against a signed permanent
 * install: "Missing host permission for the tab" with file:///* present in
 * both permissions and content_scripts.matches). The toolbar click therefore
 * can't bring out the pill there; swap the click for a popup that says so and
 * hands over the http-server workaround. Other pages keep the toggle click. */
function syncPopup(tabId, url) {
  if (!url) return;
  browser.browserAction
    .setPopup({ tabId, popup: url.startsWith("file:") ? "popup.html" : "" })
    .catch(() => {}); // tab may already be gone
}
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  syncPopup(tabId, changeInfo.url ?? tab.url);
});
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    syncPopup(tabId, (await browser.tabs.get(tabId)).url);
  } catch {
    /* tab gone */
  }
});
