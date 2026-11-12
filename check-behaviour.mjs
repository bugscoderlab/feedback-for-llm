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
      sendMessage: async (msg) => {
        window.__lastMsg = msg;
        if (msg && msg.type === "ffab:pick-state?") return window.__pickState ?? { active: false };
        return {};
      },
      onMessage: {
        addListener: (fn) => { msgListener = fn; },
        removeListener: (fn) => { if (msgListener === fn) msgListener = null; },
      },
      getManifest: () => ({ version: "0.0.0" }),
    },
  };
  window.__store = () => store;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t) => { window.__export = t; return Promise.resolve(); } },
  });
  window.alert = (m) => { window.__alerts = (window.__alerts || []).concat(m); };
  window.confirm = (m) => { window.__confirms = (window.__confirms || []).concat(m); return true; };
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
    check("step button reads as armed", $("ffab-dr-step").textContent.indexOf("Tab/[") !== -1);

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

    // 7b. a dropdown: the press is swallowed so the menu cannot open, and the
    // pick still lands in the remark popover
    click($("ffab-dr-pick"));
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    $("demo-select").dispatchEvent(press);
    check("picking swallows the mousedown (a dropdown cannot open)", press.defaultPrevented);
    click($("demo-select"));
    await sleep(30);
    check("a pick on a dropdown opens the remark popover", !$("ffab-pop").classList.contains("ffab-hidden"));
    click($("ffab-ap-cancel"));
    await sleep(30);
    click($("ffab-fab")); // put the drawer back as it was
    await sleep(30);

    // 7c. escalation: Tab walks the pick up the ancestor chain, so a container
    // can be picked even when the cursor sits on a child inside it
    click($("ffab-dr-pick"));
    const saveBtn = $("save");
    const sbr = saveBtn.getBoundingClientRect();
    saveBtn.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: sbr.x + sbr.width / 2, clientY: sbr.y + sbr.height / 2 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await sleep(30);
    click(saveBtn);
    await sleep(30);
    check("Tab escalates the pick to the parent container",
      $("ffab-ap-sel").textContent.trim() === "div.card", $("ffab-ap-sel").textContent.trim());
    click($("ffab-ap-cancel"));
    await sleep(30);
    click($("ffab-fab")); // put the drawer back as it was
    await sleep(30);

    // 7d. [ cycles through OVERLAPPING elements stacked at a point, not just
    // ancestors — the front layer is on top, the back layer sits under it
    click($("ffab-dr-pick"));
    const front = $("layer-front");
    const fr = front.getBoundingClientRect();
    front.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: fr.x + 6, clientY: fr.y + 6 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
    await sleep(30);
    click(front);
    await sleep(30);
    check("] reaches the element stacked behind",
      $("ffab-ap-sel").textContent.trim() === "#layer-back", $("ffab-ap-sel").textContent.trim());
    click($("ffab-ap-cancel"));
    await sleep(30);
    click($("ffab-fab")); // put the drawer back as it was
    await sleep(30);

    // 7f. clicking a numbered marker reopens the remark for editing
    const marker = $("ffab-markers").querySelector(".ffab-marker");
    check("the remark pins a numbered marker", !!marker && marker.textContent === "1");
    click(marker);
    await sleep(30);
    check("marker click pops the comment back up", !$("ffab-pop").classList.contains("ffab-hidden"));
    check("the popover carries the existing note",
      $("ffab-ap-note").value === "make the Save button enabled once the email is valid");
    $("ffab-ap-note").value = "make the Save button enabled once the email is valid (edited)";
    click($("ffab-ap-save"));
    await sleep(30);
    check("saving writes the note back, adding no remark",
      rec().annotations.length === 1 && rec().annotations[0].note.indexOf("(edited)") !== -1);

    // 7g. picking reaches inside iframes: the subframe relay mirrors the
    // crosshair and forwards the pick to the top frame. The harness is not a
    // real extension install, so inject the script into the frame by hand and
    // hand it the stubbed browser API, mimicking what all_frames injection
    // would do.
    const fdoc = $("demo-frame").contentDocument;
    fdoc.defaultView.browser = window.browser; // the API the relay talks to
    const fscript = fdoc.createElement("script");
    await new Promise((res) => { fscript.onload = res; fscript.src = "content.js"; fdoc.body.appendChild(fscript); });
    const fbtn = fdoc.getElementById("in-frame-btn");
    const F = fdoc.defaultView;
    check("the test frame is reachable", !!fbtn);
    click($("ffab-dr-pick"));
    window.__pickState = { active: true, mode: "remark" }; // what the background would answer
    fbtn.dispatchEvent(new F.MouseEvent("mousemove", { bubbles: true, clientX: 12, clientY: 8 }));
    await sleep(120); // relay syncs its armed state
    const fdown = new F.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 12, clientY: 8 });
    fbtn.dispatchEvent(fdown);
    check("the relay swallows the press inside the frame", fdown.defaultPrevented);
    fbtn.dispatchEvent(new F.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 12, clientY: 8 }));
    await sleep(120);
    check("the relayed pick names the in-frame element",
      window.__lastMsg?.type === "ffab:relay-pick" && window.__lastMsg.target?.selector === "#in-frame-btn",
      JSON.stringify(window.__lastMsg));
    msgListener(window.__lastMsg); // the background forwards it to the top frame
    await sleep(30);
    check("the top frame opens the popover for it",
      !$("ffab-pop").classList.contains("ffab-hidden") && $("ffab-ap-sel").textContent.trim() === "#in-frame-btn");
    click($("ffab-ap-cancel"));
    await sleep(30);
    window.__pickState = { active: false };
    click($("ffab-fab")); // put the drawer back as it was
    await sleep(30);

    // 8. the brief
    click($("ffab-dr-copy"));
    await sleep(60);
    const md = window.__export || "";
    check("export exists", !!md);
    check("copy reports on its own button, not in a dialog",
      (window.__alerts || []).length === 0, JSON.stringify(window.__alerts || []));
    check("copy button says what happened",
      $("ffab-dr-copy").textContent.indexOf("Copied") !== -1, $("ffab-dr-copy").textContent);
    await sleep(1700);
    check("copy button goes back to normal",
      $("ffab-dr-copy").textContent === "📋 Copy", $("ffab-dr-copy").textContent);
    check("header counts the steps", md.indexOf("4 step(s) to reproduce") !== -1);
    check("steps block is headed", md.indexOf("## Steps to reproduce") !== -1);
    const where = WANT_STEPS.map((l) => md.indexOf(l));
    check("steps are numbered in order",
      where.every((p, i) => p !== -1 && (i === 0 || p > where[i - 1])),
      WANT_STEPS.filter((l, i) => where[i] === -1).join(" / ") || "in order");
    check("steps come before the review", md.indexOf("## Steps to reproduce") < md.indexOf("Review:"));
    check("review follows the steps", md.indexOf("Review:") < md.indexOf(REVIEW) && md.indexOf(REVIEW) !== -1);
    check("remarks still follow the review", md.indexOf(REVIEW) < md.indexOf("## 1. [OPEN] button"));

    // 9. re-injecting after an extension update: the old instance's listener is
    //    dead (it belonged to the previous version), and the script must retire
    //    the old instance and re-arm — with no flag to clear, or the toolbar
    //    toggle lands on no live listener. That was the "click, nothing
    //    happens" bug.
    msgListener = null; // the update killed the old version's listener
    const script = document.createElement("script");
    await new Promise((res) => { script.onload = res; script.src = "content.js"; document.body.appendChild(script); });
    await sleep(60);
    check("re-inject restores the steps",
      !!$("ffab-dr-steps") && $("ffab-dr-steps").textContent.indexOf("Steps to reproduce (4)") !== -1);
    check("re-inject restores the review", $("ffab-dr-review-note").value === REVIEW);
    check("re-inject leaves one drawer", document.querySelectorAll("#ffab-drawer").length === 1);
    // The re-armed instance answers the toolbar toggle — this is the
    // "clicked after an update, nothing happened" regression: before the
    // teardown design, the re-injected script bailed on its loaded-flag and no
    // live listener remained, so these calls did nothing at all.
    check("re-inject reinstated the pill", !$("ffab-fab").classList.contains("ffab-hidden"));
    msgListener({ type: "ffab:toggle" });
    check("the toggle answers after re-inject (pill away)", $("ffab-fab").classList.contains("ffab-hidden"));
    msgListener({ type: "ffab:toggle" });
    check("the toggle answers after re-inject (pill back)", !$("ffab-fab").classList.contains("ffab-hidden"));

    // 10. Clear all asks in place with an explicit ✓/✕ — no dialog — then
    // takes the walkthrough with it: steps, review, remarks, basket
    const dialogsBefore = (window.__confirms || []).length;
    click($("ffab-dr-clear"));
    await sleep(50);
    check("clear all asks before wiping",
      rec().steps.length === 4 && !$("ffab-dr-ask").classList.contains("ffab-hidden")
        && $("ffab-dr-clear").classList.contains("ffab-hidden"));
    check("clear all raises no dialog",
      (window.__confirms || []).length === dialogsBefore && (window.__alerts || []).length === 0,
      JSON.stringify([window.__confirms || [], window.__alerts || []]));
    click($("ffab-dr-ask-no"));
    await sleep(30);
    check("cross cancels the wipe",
      $("ffab-dr-ask").classList.contains("ffab-hidden")
        && !$("ffab-dr-clear").classList.contains("ffab-hidden")
        && rec().steps.length === 4);
    click($("ffab-dr-clear"));
    await sleep(30);
    click($("ffab-dr-ask-yes"));
    await sleep(50);
    check("tick clears", rec().steps.length === 0);
    check("clear all empties the stored steps", rec().steps.length === 0, JSON.stringify(rec().steps));
    check("clear all empties the stored review", rec().review === "", JSON.stringify(rec().review));
    check("clear all empties remarks and basket",
      rec().annotations.length === 0 && rec().basket.length === 0);
    check("clear all hides the steps section", $("ffab-dr-steps").classList.contains("ffab-hidden"));
    check("clear all empties the steps list", $("ffab-dr-steps").innerHTML === "");
    check("clear all empties the review box", $("ffab-dr-review-note").value === "");
    check("clear all hides the review box", $("ffab-dr-review").classList.contains("ffab-hidden"));
    check("clear all hides itself", $("ffab-dr-clear").classList.contains("ffab-hidden"));

    // 11. the steps section's own clear drops the steps and nothing else
    click($("ffab-dr-step"));
    click($("add-user"));
    click($("email"));
    await sleep(30);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await sleep(30);
    check("a second run records again", rec().steps.length === 2, JSON.stringify(rec().steps.length));
    const stepClear = $("ffab-dr-steps").querySelector('[data-act="steps-clear"]');
    check("the steps section offers its own clear", !!stepClear);
    click(stepClear);
    await sleep(30);
    check("steps clear empties the steps", rec().steps.length === 0);
    check("steps clear hides the section", $("ffab-dr-steps").classList.contains("ffab-hidden"));
    check("steps clear empties the list", $("ffab-dr-steps").innerHTML === "");

    // 12. the ask stands down when cancelled, and never clears on its own
    click($("ffab-dr-step"));
    click($("add-user"));
    await sleep(30);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await sleep(30);
    check("a third run records again", rec().steps.length === 1);
    click($("ffab-dr-clear"));
    check("clear all asks", !$("ffab-dr-ask").classList.contains("ffab-hidden"));
    click($("ffab-dr-ask-no"));
    await sleep(30);
    check("cross stands the ask down",
      $("ffab-dr-ask").classList.contains("ffab-hidden")
        && !$("ffab-dr-clear").classList.contains("ffab-hidden"));
    check("the cancelled ask did not clear anything", rec().steps.length === 1);

    // 13. locating something the view has moved on from reports on its own button
    const alertCount = (window.__alerts || []).length;
    $("add-user").remove();
    const locateBtn = $("ffab-dr-steps").querySelector('[data-act="step-locate"]');
    click(locateBtn);
    await sleep(30);
    check("a locate that fails says so on its button",
      locateBtn.textContent.indexOf("not here") !== -1, locateBtn.textContent);
    check("a locate that fails raises no dialog", (window.__alerts || []).length === alertCount);

    // 14. Load round-trips the record through a JSON file (picker driven by
    //    feeding the input a File, exactly what the user picks)
    click($("ffab-dr-load"));
    await sleep(30);
    check("load asks before replacing existing feedback",
      !$("ffab-dr-ask").classList.contains("ffab-hidden")
        && $("ffab-dr-load").classList.contains("ffab-hidden"));
    click($("ffab-dr-ask-yes"));
    await sleep(30);
    const inp = document.querySelector("input[type=file]");
    check("load opens a file picker", !!inp);
    const fileRec = {
      app: "feedback-for-llm",
      format: 1,
      annotations: [
        { num: 1, status: "open", note: "loaded from file", selector: "#email",
          label: "input “Email”", docCtx: "Invoice scanner · /index.html", content: "", at: new Date().toISOString() },
      ],
      seq: 2,
      basket: [],
      steps: [
        { selector: "#save", label: "button “Save”", docCtx: "Invoice scanner · /index.html", content: "", at: new Date().toISOString() },
      ],
      review: "loaded review",
    };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(fileRec)], "feedback.json", { type: "application/json" }));
    Object.defineProperty(inp, "files", { configurable: true, value: dt.files });
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 60 && $("ffab-dr-load").textContent.indexOf("Loaded") === -1; i++) await sleep(50);
    check("load replaces the record",
      rec().annotations.length === 1 && rec().annotations[0].note === "loaded from file");
    check("load restores steps, review, and seq",
      rec().steps.length === 1 && rec().review === "loaded review" && rec().seq === 2);
    check("the review box shows the loaded review", $("ffab-dr-review-note").value === "loaded review");
    check("load reports on its own button", $("ffab-dr-load").textContent.indexOf("Loaded") !== -1,
      $("ffab-dr-load").textContent);
    // and a bad file is refused, not fatal
    const dt2 = new DataTransfer();
    dt2.items.add(new File(["{\\"nope\\":true}"], "bad.json", { type: "application/json" }));
    pickAgain: {
      $("ffab-dr-load").dispatchEvent(new MouseEvent("click", { bubbles: true })); // record non-empty now -> asks
      click($("ffab-dr-ask-yes"));
      await sleep(30);
      const inp2 = document.querySelector("input[type=file]");
      Object.defineProperty(inp2, "files", { configurable: true, value: dt2.files });
      inp2.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 60 && $("ffab-dr-load").textContent.indexOf("Not a feedback") === -1; i++) await sleep(50);
    }
    check("a non-feedback file is refused without touching the record",
      rec().annotations.length === 1 && $("ffab-dr-load").textContent.indexOf("Not a feedback") !== -1,
      $("ffab-dr-load").textContent);

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
    <select id="demo-select"><option>One</option><option>Two</option></select>
    <div style="position:relative;height:50px;margin-top:8px">
      <div id="layer-back" style="position:absolute;inset:0;background:#fee">back</div>
      <div id="layer-front" style="position:absolute;inset:0">front</div>
    </div>
    <iframe id="demo-frame" srcdoc="<button id='in-frame-btn'>Inside frame</button>"></iframe>
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
      "--virtual-time-budget=20000",
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
