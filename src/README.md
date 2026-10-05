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

  Act on OPEN remarks; RESOLVED ones are done.
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
3. When done, **📋 Copy brief** and paste it to your LLM agent (or **⬇ feedback.md**).

## Notes & limitations

- Remarks are scoped per page (`origin + pathname`, query ignored).
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
