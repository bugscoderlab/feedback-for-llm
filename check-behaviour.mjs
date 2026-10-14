#!/usr/bin/env node
/**
 * Behaviour check for the content script.
 *
 * There is no test runner in this repo, and the parts of content.js that break
 * are the parts nothing else can check: which click does what, what the export
 * actually says, and what survives a page reload. So this drives the real
 * src/content.js in a real DOM — headless Chrome, the shipped CSS linked — and
 * asserts the walkthrough flow end to end.
 *
 * Nothing is faked except the two WebExtension APIs the script talks to
 * (storage.local, runtime) and window.alert/clipboard. Picking, persistence,
 * the drawer, the markers and the markdown brief all run for real.
 *
 * Usage:  node check-behaviour.mjs [--chrome <path>] [--verbose] [--keep]
 *   --chrome   Chrome/Chromium binary (default: $CHROME, the macOS app, or PATH)
 *   --verbose  always print the exported brief, not just on failure
 *   --keep     leave the generated harness directory behind
 *
 * On failure it reproduces the document it happened in: the harness dir holds
 * index.html plus the content.js/css it ran against, so you can open that file
 * in a browser and click through it by hand.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

/* ---------------- find a browser ---------------- */

function findChrome() {
  const candidates = [
    opt("--chrome") || process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/* ---------------- the harness ---------------- */

// A stub for storage.local, a driver that plays the reviewer, and the
// assertions. Plain string concatenation inside — this page is embedded in a
// template literal below, so a nested `${` would be interpolated by Node.
const HARNESS_JS = `
  let store = {};
  let msgListener = null;
  window.browser = {
    storage: {
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
    runtime: {
      sendMessage: async () => {},
      onMessage: { addListener: (fn) => { msgListener = fn; } },
    },
  };
  window.__store = () => store;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t) => { window.__export = t; return Promise.resolve(); } },
  });
  window.alert = (m) => { window.__alerts = (window.__alerts || []).concat(m); };
</script>
<script src="content.js"></script>
<script>
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const $ = (id) => document.getElementById(id);
  const log = [];
  const rec = () => { const st = window.__store(); return st[Object.keys(st)[0]]; };
  const check = (name, ok, extra) => log.push((ok ? "PASS " : "FAIL ") + name + (extra ? " (" + extra + ")" : ""));

  const REVIEW = "I picked Add user, typed an email, then Save stayed greyed out.";
  const WANT_STEPS = [
    "1. button \\u201cAdd user\\u201d \\u2014 \\\`#add-user\\\`",
    "2. input \\u201cEmail\\u201d \\u2014 \\\`#email\\\`",
    "3. button \\u201cSave\\u201d \\u2014 \\\`#save\\\`",
    "4. button \\u201cAdd user\\u201d \\u2014 \\\`#add-user\\\`",
  ];

  async function run() {
    // 1. the toolbar button drops the pill, and nothing else
    msgListener({ type: "ffab:toggle" });
    check("toolbar button shows the pill", !$("ffab-fab").classList.contains("ffab-hidden"));
    check("toolbar button leaves the drawer closed", $("ffab-drawer").classList.contains("ffab-hidden"));

    // 2. the pill opens the drawer
    click($("ffab-fab"));
    check("pill opens the drawer", !$("ffab-drawer").classList.contains("ffab-hidden"));

    // 3. arming the walkthrough takes over the page like the other pickers
    click($("ffab-dr-step"));
    check("step mode marks the body", document.body.classList.contains("ffab-stepping"));
    check("step mode hides the drawer", $("ffab-drawer").classList.contains("ffab-hidden"));
    check("step button reads as armed", $("ffab-dr-step").textContent.indexOf("Esc to write") !== -1);

    // 4. a run of picks: each appends a step, the picker stays armed
    click($("add-user"));
    await sleep(30);
    check("pick appends step 1", rec().steps.length === 1);
    check("step 1 carries a selector and a label",
      rec().steps[0].selector === "#add-user" && rec().steps[0].label === "button \\u201cAdd user\\u201d",
      JSON.stringify(rec().steps[0]));
    check("picker stays armed after a pick", document.body.classList.contains("ffab-stepping"));
    click($("email"));
    await sleep(30);
    click($("save"));
    await sleep(30);
    check("three picks are three steps", rec().steps.length === 3);
    check("pill counts the run", $("ffab-cnt").textContent === "3" && $("ffab-fab-label").textContent.indexOf("Steps") !== -1,
      $("ffab-fab-label").textContent + " " + $("ffab-cnt").textContent);
    check("steps put no markers on the page", document.querySelectorAll("#ffab-markers .ffab-marker").length === 0);

    // 5. Esc ends the run and puts the writing in front of the reviewer
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await sleep(30);
    check("Esc leaves step mode", !document.body.classList.contains("ffab-stepping"));
    check("Esc opens the drawer", !$("ffab-drawer").classList.contains("ffab-hidden"));
    check("steps section is visible", !$("ffab-dr-steps").classList.contains("ffab-hidden"));
    check("review box is visible", !$("ffab-dr-review").classList.contains("ffab-hidden"));
    check("steps are listed in order",
      [].map.call($("ffab-dr-steps").querySelectorAll(".ffab-bk-label"), (n) => n.textContent).join(" | ") ===
        "button \\u201cAdd user\\u201d | input \\u201cEmail\\u201d | button \\u201cSave\\u201d",
      [].map.call($("ffab-dr-steps").querySelectorAll(".ffab-bk-label"), (n) => n.textContent).join(" | "));

    // 6. write it down, then resume the run — the words must not be lost
    const ta = $("ffab-dr-review-note");
    ta.value = REVIEW;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    check("review is persisted as it is typed", rec().review === REVIEW);
    click($("ffab-dr-step"));
    click($("add-user"));
    await sleep(30);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await sleep(30);
    check("run resumes to a fourth step", rec().steps.length === 4);
    check("review survives the resume", $("ffab-dr-review-note").value === REVIEW);

    // 7. a remark on top, so the brief carries both halves
    click($("ffab-dr-pick"));
    click($("save"));
    await sleep(30);
    $("ffab-ap-note").value = "make the Save button enabled once the email is valid";
    click($("ffab-ap-save"));
    await sleep(30);
    check("remark is saved", rec().annotations.length === 1);
    check("review box is untouched by a remark", $("ffab-dr-review-note").value === REVIEW);

    // 8. the brief
    click($("ffab-dr-copy"));
    await sleep(60);
    const md = window.__export || "";
    check("export exists", !!md);
    check("header counts the steps", md.indexOf("4 step(s) to reproduce") !== -1);
    check("steps block is headed", md.indexOf("## Steps to reproduce") !== -1);
    const where = WANT_STEPS.map((l) => md.indexOf(l));
    check("steps are numbered in order",
      where.every((p, i) => p !== -1 && (i === 0 || p > where[i - 1])),
      WANT_STEPS.filter((l, i) => where[i] === -1).join(" / ") || "in order");
    check("steps come before the review", md.indexOf("## Steps to reproduce") < md.indexOf("Review:"));
    check("review follows the steps", md.indexOf("Review:") < md.indexOf(REVIEW) && md.indexOf(REVIEW) !== -1);
    check("remarks still follow the review", md.indexOf(REVIEW) < md.indexOf("## 1. [OPEN] button"));

    // 9. reloading / re-injecting on update rebuilds from storage
    window.__ffabLoaded = false;
    const script = document.createElement("script");
    await new Promise((res) => { script.onload = res; script.src = "content.js"; document.body.appendChild(script); });
    await sleep(60);
    check("re-inject restores the steps",
      !!$("ffab-dr-steps") && $("ffab-dr-steps").textContent.indexOf("Steps to reproduce (4)") !== -1);
    check("re-inject restores the review", $("ffab-dr-review-note").value === REVIEW);
    check("re-inject leaves one drawer", document.querySelectorAll("#ffab-drawer").length === 1);

    const out = document.createElement("pre");
    out.id = "result";
    out.textContent = "RESULTS\\n" + log.join("\\n") + "\\nEXPORT_START\\n" + md + "\\nEXPORT_END";
    document.body.appendChild(out);
  }

  run().catch((e) => {
    const out = document.createElement("pre");
    out.id = "result";
    out.textContent = "RESULTS\\n" + log.join("\\n") + "\\nTHREW " + ((e && e.stack) || e);
    document.body.appendChild(out);
  });
`;

function harnessHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice scanner</title>
<link rel="stylesheet" href="feedback.css">
<style>
  body { font: 14px system-ui; padding: 40px; }
  .card { border: 1px solid #ddd; padding: 16px; width: 320px; }
  input, button { font: inherit; }
</style>
</head>
<body>
  <h1>Invoices</h1>
  <div class="card">
    <button id="add-user">Add user</button>
    <input id="email" placeholder="Email">
    <button id="save">Save</button>
  </div>
<script>
${HARNESS_JS}
</script>
</body>
</html>
`;
}

/* ---------------- run ---------------- */

const chrome = findChrome();
if (!chrome) {
  console.error(
    "check-behaviour: no Chrome/Chromium found.\n" +
      "  Install one, or point at it:  node check-behaviour.mjs --chrome /path/to/chrome",
  );
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), "ffab-behaviour-"));
await Promise.all([
  copyFile(join(here, "src/content.js"), join(dir, "content.js")),
  copyFile(join(here, "src/feedback.css"), join(dir, "feedback.css")),
  writeFile(join(dir, "index.html"), harnessHtml()),
]);

let dom;
try {
  dom = execFileSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--allow-file-access-from-files",
      "--virtual-time-budget=15000",
      "--dump-dom",
      `file://${join(dir, "index.html")}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
} catch (err) {
  console.error(`check-behaviour: could not run ${chrome}\n${err.message}`);
  if (!flag("--keep")) await rm(dir, { recursive: true, force: true });
  process.exit(2);
}

const match = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error(
    "check-behaviour: the harness never reported back — the page likely threw before it\n" +
      "could run. The generated document is kept for inspection:\n" +
      `  open "${join(dir, "index.html")}"`,
  );
  process.exit(2);
}

const unescape = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const report = unescape(match[1]);
const exportText = report.split("EXPORT_START\n")[1]?.split("\nEXPORT_END")[0] ?? "";
const lines = report.split("\n").filter((l) => /^(PASS|FAIL|THREW)/.test(l));
const failed = lines.filter((l) => l.startsWith("FAIL") || l.startsWith("THREW"));

if (!flag("--keep")) await rm(dir, { recursive: true, force: true });
else console.log(`check-behaviour: harness kept in ${dir}\n`);

console.log(lines.map((l) => `  ${l.toLowerCase().startsWith("fail") ? "FAIL" : l.startsWith("THREW") ? "THREW" : "ok  "} ${l.replace(/^(PASS|FAIL|THREW) /, "")}`).join("\n"));

if (failed.length || !exportText) {
  console.error(`\ncheck-behaviour: ${failed.length || "no"} failure(s) driving src/content.js`);
  if (exportText) {
    console.error("\n--- the brief it exported ---");
    console.error(exportText.trimEnd());
  }
  process.exit(1);
}

if (flag("--verbose")) {
  console.log("\n--- the brief it exported ---");
  console.log(exportText.trimEnd());
}
console.log(`\ncheck-behaviour: OK (${lines.length} assertions, ${chrome})`);
