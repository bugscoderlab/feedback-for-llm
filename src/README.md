# 📝 Feedback for LLM — Firefox extension

A browser-extension port of the annotation/feedback mode from
[`docs/brief/prototype/`](../docs/brief/prototype/index.html) ("📝 Feedback for
LLM"). It works on **any page** — including the invoice-scanner app — and lets
you collect visual, element-precise UI remarks and hand them to an LLM coding
agent as a markdown brief.

## What it does

- **🎯 Pick element** — the cursor becomes a crosshair; hovering
  highlights the target; clicking opens the remark popover with a generated
  label ("button “Approve all pending”", "column header “Qty”", …), the page
  context, and the element's CSS selector.
- **🚫 Remove element** — the same crosshair (the highlight turns red), but
  each click skips the popover and drops the element straight into the **removal
  basket**: no note to write, no per-element form. The picker stays armed so you can
  basket a whole run of elements, and the pill counts them as you go; Esc finishes.
  Basket entries show as red ✕ markers and as their own list above the remarks, each
  with an ✕ to unmark.
  The two pickers sit side by side at the top of the drawer.
- **🧭 Record steps** — the walkthrough: the run of clicks that got you to the
  problem, which the popover's one-shot remarks can't express. The picker works the
  same way (teal highlight, picks skip the popover), each click appends the next step,
  and it stays armed so the whole run is one motion; the pill counts the steps as you
  go. **Esc ends the run and opens the drawer to write your Review** — because the
  point of stopping is having something to write down. Steps and review are positional
  and persisted per page, so you can stop mid-run, reload, and pick it back up.
- **💾 Save remark** — numbered markers pin to the elements; clicking a marker
  opens the drawer. Remarks persist per page in `browser.storage.local`
  (survive reloads and browser restarts).
- **Drawer** — every remark with *locate* (scrolls to the element and flashes
  it), *resolve/reopen*, and *delete*; every step with *locate* and *drop*.
  Footer accepts a raw CSS selector pasted from Firefox Inspect. **🗑 Clear all**
  appears only when there is something to clear, and asks a second time on the button
  itself rather than in a dialog.
- **📋 Copy / ⬇ feedback.md** — exports exactly the prototype's format, with the
  walkthrough in front of it:

  ```markdown
  # UI feedback — <page title>
  Page: <origin + path>
  Exported: … · 2 open remark(s), 3 total · 3 step(s) to reproduce

  ## Steps to reproduce

  1. button "Add user" — `#add-user`
  2. input "Email" — `.modal form > input:nth-of-type(2)`
  3. button "Save" — `.modal footer > button`

  Review:
  <what you did, what you expected, what happened>

  ## 1. [OPEN] button "Approve all pending"
  - Where: … · localhost:3000/
  - Selector: `.q-item:nth-of-type(4) > button`
  - Currently shows: "approve"
  Requested change:
  make it a primary button
  ```

  Steps first, so the agent follows the journey before the requests; then act on OPEN
  remarks (RESOLVED ones are done). When elements were basketed, a
  `## Remove these elements` block of selectors follows the remarks. Copy says so on
  its own button (`✓ Copied`) — no dialog to dismiss.
- **Toolbar button** drops the on-page **📝 Feedback *n* pill** and shows an
  open-remark badge count. The drawer opens only from the pill; clicking the toolbar
  button again takes the pill (and drawer) away, so a page stays clean until asked.

## Install (dev)

Temporary (until browser restart):

1. Open `about:debugging` → **This Firefox**.
2. **Load Temporary Add-on…** → select `feedback-extension/manifest.json`.

For a persistent loop, use [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```sh
cd feedback-extension
npx web-ext run            # launches Firefox with the extension, auto-reloads on change
```

## Usage

1. On any page, click the toolbar button — the **📝 Feedback *n*** pill drops into
   the bottom-right corner. Click the pill to open the drawer.
2. **🎯 Pick element**, click the element, write the change, **💾 Save remark**.
3. To explain how you got there instead, **🧭 Record steps** and click the elements in
   order — then Esc and write your **Review**. Steps and review persist per page, so you
   can stop mid-run and pick it back up later.
4. To delete elements, use **🚫 Remove element** and click each one
   (no note needed), then Esc — they collect in the removal basket above the remarks.
5. When done, **📋 Copy brief** and paste it to your LLM agent (or **⬇ feedback.md**).

## Notes & limitations

- **The toolbar button on a `file://` tab opens an explanatory popup instead
  of the pill.** Firefox never allows extension content on local files — no
  permission exists (verified against a signed permanent install). The popup
  hands over the commands to serve the folder over http; don't try to "fix"
  this with more manifest permissions.
- Remarks are scoped per page (`origin + pathname`, query ignored).
- **The extension raises no browser dialogs** — no `alert`, no `confirm`. Firefox
  stops showing dialogs for a page that has already shown a few, and a suppressed
  `confirm()` returns `false` with nothing on screen to explain it, so the button
  reads as broken from then on. Copy, Clear all and a failed *locate* all report on
  the button that was clicked instead. Keep it that way.
- Updating the extension does NOT reload content scripts in already-open tabs —
  Firefox only re-injects on a dev reload, so a real update leaves the old
  instance running with a dead message listener until the page reloads or the
  script is injected again. The extension heals this itself: the background
  injects `content.js` when a click finds no listener (see `background.js`),
  and the injected instance retires the previous one via `__ffabTeardown` —
  removing its listeners and UI — before re-arming, so exactly one live
  listener exists per page. (Without that retirement, the old UI would linger
  and two drawers would coexist invisibly; see the clean-slate block in
  `content.js`.)
- Styles are `ffab-`-prefixed and injected via the manifest (CSP-exempt), but
  marker/popover *positioning* uses inline styles — on pages with a strict
  `style-src` CSP (no `'unsafe-inline'`), positioning may degrade. Dev servers
  like the invoice-scanner app are unaffected.
- Regenerate icons after editing the glyph: `node tools/gen-icons.js`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV2 manifest: content script on all URLs, storage, background |
| `background.js` | Toolbar click → toggle pill, injecting the content script on demand if the tab isn't ready; open-remark badge |
| `content.js` | Picking (remark / remove / step), selectors, descriptions, popover, drawer, markers, export |
| `popup.html` / `popup.js` | What the toolbar button shows on `file://` tabs, where Firefox forbids extension content: the platform restriction plus the http-server workaround |
| `feedback.css` | Prototype-styled UI, `ffab-`-prefixed |
| `icons/` | Extension icons (generated, see `tools/gen-icons.js`) |
