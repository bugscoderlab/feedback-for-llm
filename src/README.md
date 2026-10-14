# 📝 Feedback for LLM — Firefox extension

A browser-extension port of the annotation/feedback mode from
[`docs/brief/prototype/`](../docs/brief/prototype/index.html) ("📝 Feedback for
LLM"). It works on **any page** — including the invoice-scanner app — and lets
you collect visual, element-precise UI remarks and hand them to an LLM coding
agent as a markdown brief.

## What it does

- **🎯 Pick element on page** — the cursor becomes a crosshair; hovering
  highlights the target; clicking opens the remark popover with a generated
  label ("button “Approve all pending”", "column header “Qty”", …), the page
  context, and the element's CSS selector.
- **🚫 Remove element on page** — the same crosshair (the highlight turns red), but
  each click skips the popover and drops the element straight into the **removal
  basket**: no note to write, no per-element form. The picker stays armed so you can
  basket a whole run of elements, and the FAB counts them as you go; Esc finishes.
  Basket entries show as red ✕ markers and as their own list above the remarks, each
  with an ✕ to unmark.
- **💾 Save remark** — numbered markers pin to the elements; clicking a marker
  opens the drawer. Remarks persist per page in `browser.storage.local`
  (survive reloads and browser restarts).
- **Drawer** — every remark with *locate* (scrolls to the element and flashes
  it), *resolve/reopen*, and *delete*. Footer accepts a raw CSS selector
  pasted from Firefox Inspect.
- **📋 Copy brief / ⬇ feedback.md** — exports exactly the prototype's format:

  ```markdown
  # UI feedback — <page title>
  Page: <origin + path>
  Exported: … · 2 open remark(s), 3 total

  ## 1. [OPEN] button "Approve all pending"
  - Where: … · localhost:3000/
  - Selector: `.q-item:nth-of-type(4) > button`
  - Currently shows: "approve"
  Requested change:
  make it a primary button
  ```

  Act on OPEN remarks; RESOLVED ones are done. When elements were basketed, a
  `## Remove these elements` block of selectors follows the remarks.
- **Toolbar button** toggles the drawer and shows an open-remark badge count.

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

1. On any page, click **📝 Feedback** (bottom-right) or the toolbar button.
2. **🎯 Pick element on page**, click the element, write the change, **💾 Save remark**.
3. To delete elements instead, use **🚫 Remove element on page** and click each one
   (no note needed), then Esc — they collect in the removal basket above the remarks.
4. When done, **📋 Copy brief** and paste it to your LLM agent (or **⬇ feedback.md**).

## Notes & limitations

- Remarks are scoped per page (`origin + pathname`, query ignored).
- Updating the extension takes effect in already-open tabs without a reload:
  Firefox re-injects the content script on update, and the new instance discards
  the previous instance's leftover UI before drawing its own (see the clean-slate
  block in `content.js`). Without that, two drawers coexist invisibly and the
  visible one keeps the old release's buttons.
- Styles are `ffab-`-prefixed and injected via the manifest (CSP-exempt), but
  marker/popover *positioning* uses inline styles — on pages with a strict
  `style-src` CSP (no `'unsafe-inline'`), positioning may degrade. Dev servers
  like the invoice-scanner app are unaffected.
- Regenerate icons after editing the glyph: `node tools/gen-icons.js`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV2 manifest: content script on all URLs, storage, background |
| `background.js` | Toolbar click → toggle drawer; open-remark badge |
| `content.js` | Picking, selectors, descriptions, popover, drawer, markers, export |
| `feedback.css` | Prototype-styled UI, `ffab-`-prefixed |
| `icons/` | Extension icons (generated, see `tools/gen-icons.js`) |
