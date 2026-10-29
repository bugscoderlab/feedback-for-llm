#!/usr/bin/env node
/**
 * Behaviour check for the toolbar-click → pill flow in src/background.js.
 *
 * The reported bug: "sometimes when I click the button on the Firefox toolbar,
 * the pill never appears." Sometimes = a race. The click sends `ffab:toggle`
 * to the tab, but the content script only registers its message listener when
 * it runs — at document_idle (see manifest.json). Click while the tab is still
 * loading (or right after a lazy session restore) and the message rejects with
 * "Receiving end does not exist"; the background's bare catch then dropped the
 * click on the floor. The check pins the recovery: inject content.js on demand
 * and resend — and pins the pages where nothing can run (about:, the built-in
 * PDF viewer) to fail quietly, not loudly.
 *
 * Loads the real background.js in Node with only `browser` stubbed, then clicks
 * the toolbar button under three tab conditions and asserts what must happen.
 *
 * Usage:  node check-toggle.mjs            # checks src/
 *         node check-toggle.mjs --dir <path>
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const dirFlag = process.argv.indexOf("--dir");
const target = resolve(here, dirFlag !== -1 ? process.argv[dirFlag + 1] : "src");

/* ---------------- stubbed browser ---------------- */

// One stub per scenario. `sendMessage`/`executeScript` are the scripted
// behaviours; `calls` records every invocation for the assertions.
function makeBrowser({ onSend, onInject }) {
  const calls = { sendMessage: [], executeScript: [] };
  const browser = {
    browserAction: {
      onClicked: { addListener: (fn) => (browser.__click = fn) },
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    },
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      sendMessage: async (...args) => {
        calls.sendMessage.push(args);
        return onSend(calls.sendMessage.length, args);
      },
      executeScript: async (...args) => {
        calls.executeScript.push(args);
        return onInject(calls.executeScript.length, args);
      },
    },
  };
  return { browser, calls };
}

/** Run background.js's real click handler against a scripted tab. */
async function clickTab(script) {
  const { browser, calls } = makeBrowser(script);
  const ctx = vm.createContext({ browser });
  vm.runInContext(await readFile(join(target, "background.js"), "utf8"), ctx, {
    filename: "background.js",
  });
  await browser.__click({ id: 7 }); // the tab the user clicked in
  return calls;
}

/* ---------------- the three tab conditions ---------------- */

const problems = [];

// 1. Content script already listening (page long since loaded) — plain relay.
{
  const calls = await clickTab({ onSend: () => {}, onInject: () => {} });
  const ok =
    calls.sendMessage.length === 1 &&
    calls.sendMessage[0][0] === 7 &&
    calls.sendMessage[0][1]?.type === "ffab:toggle" &&
    calls.executeScript.length === 0;
  if (ok) console.log("  ok   ready tab        → toggle relayed, nothing injected");
  else problems.push(`ready tab: expected 1 sendMessage (toggle) and 0 executeScript, got ${calls.sendMessage.length}/${calls.executeScript.length}`);
}

// 2. THE BUG: script not there yet (tab still loading). The click must inject
//    content.js and resend — not give up silently.
{
  let delivered = false;
  const calls = await clickTab({
    onSend: (n) => {
      if (n === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
      delivered = true;
    },
    onInject: () => {},
  });
  const injected =
    calls.executeScript.length === 1 &&
    calls.executeScript[0][0] === 7 &&
    calls.executeScript[0][1]?.file === "/content.js" &&
    calls.executeScript[0][1]?.runAt === "document_idle";
  const ok = injected && calls.sendMessage.length === 2 && delivered;
  if (ok) console.log("  ok   loading tab      → content.js injected, toggle resent and delivered");
  else problems.push(`loading tab: expected inject of content.js then a resent toggle; injected=${JSON.stringify(calls.executeScript[0]?.[1] ?? null)}, sendMessage calls=${calls.sendMessage.length}, delivered=${delivered}`);
}

// 3. Pages that can never host content scripts (about:newtab, the built-in
//    PDF viewer): injection fails too — the click must fail quietly, no
//    unhandled rejection.
{
  let clickSettled = true;
  const calls = await clickTab({
    onSend: () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
    onInject: () => {
      throw new Error("Permission denied to inject into this page.");
    },
  }).catch(() => (clickSettled = false));
  const ok = clickSettled && calls.executeScript.length === 1;
  if (ok) console.log("  ok   unscriptable tab → injection attempted, click fails quietly");
  else problems.push(`unscriptable tab: the click should settle quietly after the injection attempt fails; settled=${clickSettled}`);
}

if (problems.length) {
  console.error(`\ncheck-toggle: ${problems.length} problem(s) in ${target}`);
  for (const p of problems) console.error(`  FAIL ${p}`);
  process.exit(1);
}
console.log(`\ncheck-toggle: OK (${target}, 3 tab condition(s) checked)`);
