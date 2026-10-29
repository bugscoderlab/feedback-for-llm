#!/usr/bin/env node
/**
 * Behaviour check for the toolbar-click → pill flow in src/background.js.
 *
 * "Sometimes when I click the button on the Firefox toolbar, the pill never
 * appears" had two stacked causes, both pinned here:
 *  1. (v1.2.2) The click sent `ffab:toggle` but the content script only
 *     listens from document_idle — a click on a loading tab rejected and was
 *     dropped. Fix: inject content.js on demand and resend.
 *  2. (v1.2.3) A tab open across an extension update kept an instance whose
 *     listener died with the old version, and re-injection no-opped on a
 *     loaded-flag. Fix: content.js retires the previous instance via
 *     __ffabTeardown and re-arms.
 *
 * This check loads the real background.js in Node with only `browser`
 * stubbed, then clicks the toolbar button under four tab conditions and
 * asserts what must happen — including that a failure is VISIBLE: a click
 * that cannot reach any content script flashes E1/E2 on the toolbar badge
 * instead of failing silently.
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
  const calls = { sendMessage: [], executeScript: [], badge: [] };
  const browser = {
    browserAction: {
      onClicked: { addListener: (fn) => (browser.__click = fn) },
      setBadgeText: (opts) => calls.badge.push(opts.text),
      setBadgeBackgroundColor: () => {},
    },
    runtime: {
      getManifest: () => ({ version: "0.0.0" }),
      onMessage: { addListener: () => {} },
    },
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
  const timers = [];
  const ctx = vm.createContext({
    browser,
    console,
    setTimeout: (fn, ms) => (timers.push([fn, ms]), timers.length),
  });
  vm.runInContext(await readFile(join(target, "background.js"), "utf8"), ctx, {
    filename: "background.js",
  });
  await browser.__click({ id: 7, url: "https://example.test/page" });
  timers.forEach(([fn]) => fn()); // fire the badge-clear timeouts
  return calls;
}

const problems = [];
const fail = (name, detail) => problems.push(`${name}: ${detail}`);

// 1. Content script already listening (page long since loaded) — plain relay,
//    no injection, no badge.
{
  const calls = await clickTab({ onSend: () => {}, onInject: () => {} });
  const ok =
    calls.sendMessage.length === 1 &&
    calls.sendMessage[0][0] === 7 &&
    calls.sendMessage[0][1]?.type === "ffab:toggle" &&
    calls.executeScript.length === 0 &&
    calls.badge.length === 0;
  if (ok) console.log("  ok   ready tab        → toggle relayed, nothing injected");
  else fail("ready tab", `expected 1 sendMessage (toggle), 0 executeScript, 0 badge; got ${calls.sendMessage.length}/${calls.executeScript.length}/${JSON.stringify(calls.badge)}`);
}

// 2. Script not there yet (tab still loading): inject content.js and resend.
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
  const ok = injected && calls.sendMessage.length === 2 && delivered && calls.badge.length === 0;
  if (ok) console.log("  ok   loading tab      → content.js injected, toggle resent and delivered");
  else fail("loading tab", `injected=${JSON.stringify(calls.executeScript[0]?.[1] ?? null)}, sendMessage calls=${calls.sendMessage.length}, delivered=${delivered}, badge=${JSON.stringify(calls.badge)}`);
}

// 3. Injection went in but the resent toggle still went unanswered — the
//    content script must have a live listener after injecting, so this is an
//    error state, and it must be VISIBLE (badge E1), not silent.
{
  const calls = await clickTab({
    onSend: () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
    onInject: () => {},
  });
  const ok = calls.executeScript.length === 1 && calls.badge[0] === "E1" && calls.badge[1] === "";
  if (ok) console.log("  ok   dead after inject → badge flashes E1, then clears");
  else fail("dead after inject", `expected badge ["E1",""], got ${JSON.stringify(calls.badge)}`);
}

// 4. Pages that can never host content scripts (about:newtab, the built-in PDF
//    viewer): injection fails too — visible as E2, and the click must not
//    reject unhandled.
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
  const ok = clickSettled && calls.executeScript.length === 1 && calls.badge[0] === "E2" && calls.badge[1] === "";
  if (ok) console.log("  ok   unscriptable tab → badge flashes E2, click fails quietly");
  else fail("unscriptable tab", `settled=${clickSettled}, badge=${calls ? JSON.stringify(calls.badge) : "n/a"}`);
}

if (problems.length) {
  console.error(`\ncheck-toggle: ${problems.length} problem(s) in ${target}`);
  for (const p of problems) console.error(`  FAIL ${p}`);
  process.exit(1);
}
console.log(`\ncheck-toggle: OK (${target}, 4 tab condition(s) checked)`);
