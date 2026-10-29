# Feedback for LLM — Firefox extension

Pick any element on any web page, attach a remark, and export a markdown brief
for your LLM coding agent. A self-distributed, **auto-updating** Firefox add-on:
install the signed `.xpi` once, and Firefox keeps it current from this repo's
GitHub Releases.

- **🎯 Pick element** — hover highlights, click opens the remark popover with a
  generated label, page context, and the element's CSS selector.
- **🚫 Remove element** — the same picker aimed at deletion: picks skip the popover
  and drop straight into a removal basket (red ✕ markers), one after another, until
  you press Esc.
- **🧭 Record steps** — the run that led to the problem: click element after element
  and each pick appends the next step, in order, the picker staying armed so the whole
  walkthrough is one motion. Esc ends it and opens the drawer to write your **Review**.
  Stop mid-run and resume whenever — steps and review persist per page.
- **💾 Save remarks** — numbered markers pin to elements, persist per page in
  `browser.storage.local` (survive reloads and restarts).
- **Drawer** — locate / resolve / reopen / delete remarks, unmark basketed elements,
  locate or drop individual steps, and accept a raw CSS selector from Firefox Inspect.
- **📋 Copy / ⬇ feedback.md** — export a markdown brief in a fixed format: a
  `## Steps to reproduce` walkthrough and its review, then the remarks
  (`[OPEN]` vs `RESOLVED`), then the `## Remove these elements` hit-list. Copy confirms
  on the button itself (`✓ Copied`) rather than in a dialog.
- **Toolbar button** drops the on-page **📝 Feedback *n* pill** (and shows an
  open-remark badge count); the drawer opens only from that pill, and the toolbar
  button puts the pill — and everything with it — away again.

## Install

1. Open the [latest release](../../releases/latest).
2. Download `feedback-for-llm-<version>.xpi`.
3. Firefox prompts to add the extension — accept. Updates arrive automatically.

> If Firefox shows the file as text instead of prompting, right-click the link →
> **Save Link As…**, then drag the saved `.xpi` into a Firefox window.

## How updates work

```
src/                    source of truth (manifest, content.js, css, icons)
   │  node build.mjs    copy + overlay gecko.id / update_url
   ▼
dist/feedback-for-llm/
   │  web-ext sign --channel=unlisted   (AMO signs it)
   ▼
GitHub Release  →  feedback-for-llm-<version>.xpi
   │                                       ▲
   │  gen-updates.mjs                      │ Firefox downloads this
   ▼                                       │
gh-pages/updates.json  ────────────────────┘
   ▲
   └── gecko.update_url, polled by installed copies
```

Firefox never reads GitHub directly. It fetches **`updates.json`** from the
HTTPS URL baked into the extension and downloads the **signed `.xpi`** named
there. Both happen to be hosted here.

## Layout

| Path | Role |
| --- | --- |
| `src/` | The extension source (edit this) |
| `release.config.json` | Repo, add-on id, channel, published `updateUrl` |
| `build.mjs` | Assemble `dist/`, overlay the release manifest, zip |
| `check-hidden.mjs` | Fail on a "hidden" class no CSS rule hides |
| `check-behaviour.mjs` | Drive `src/content.js` in headless Chrome and assert the flows |
| `check-toggle.mjs` | Drive `src/background.js` with a stubbed `browser` and assert the toolbar click reaches the pill (inject-on-retry) |
| `gen-updates.mjs` | Rewrite `updates.json`, stage the `gh-pages` payload |
| `updates.json` | Seed manifest (the live copy is on `gh-pages`) |
| `.github/workflows/release-extension.yml` | build → lint → sign → Release → Pages |

## Develop

```sh
npx --yes web-ext@10 run --source-dir src
```

Or load `src/manifest.json` via `about:debugging` → **Load Temporary Add-on…**.

There are two checks, both run from the repo root:

```sh
node check-hidden.mjs      # every ffab-hidden class is actually hidden
node check-toggle.mjs      # the toolbar click always reaches the pill (or fails quietly)
node check-behaviour.mjs   # picking, steps, persistence, export — needs Chrome
```

`check-behaviour.mjs` runs the real content script in a real DOM (headless
Chrome, the shipped CSS linked) with only `storage.local`/`runtime` stubbed, so
it covers what a unit test can't: which click does what, what the markdown brief
actually says, and what survives a re-inject. It is a dev check and is not wired
into the release workflow.

## Release

1. Bump `version` in [`src/manifest.json`](src/manifest.json).
2. Commit and push to `main`.
3. Tag the version and push — the tag must equal the manifest version:

   ```sh
   git tag v1.1.0 && git push origin v1.1.0
   ```

The workflow signs with AMO, publishes a GitHub Release, and refreshes
`gh-pages/updates.json`. Force an update check in Firefox via `about:addons` →
⚙️ → **Check for Updates**.

### Required repo setup

- **Secrets** → Actions: `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`
  ([generate](https://addons.mozilla.org/developers/addon/api/key/)).
- **Pages** → Settings → Pages → Source: Deploy from a branch → `gh-pages` / root.

## Notes & gotchas

- **Signing is mandatory.** Unsigned `.xpi`s install only as temporary add-ons
  or in Developer Edition/Nightly; even self-distributed builds go through AMO's
  unlisted channel.
- **`update_url` is sticky.** Installed copies keep polling the URL from the
  version they installed — changing it later only reaches users via an
  already-published version.
- **Pages, not `raw.githubusercontent.com`** — raw serves `text/plain`; Pages
  serves `application/json` at a stable HTTPS URL.
- **`file://` pages can't host the pill — a Firefox platform rule, not a
  permission.** Firefox never lets extension content into `file://` documents:
  a signed permanent install with `file:///*` in both `permissions` and
  `content_scripts.matches` still gets "Missing host permission for the tab"
  (see bug 1253646 — Firefox has no per-extension file-access grant). On such
  tabs the toolbar button opens a popup that explains this and offers the
  http-server workaround; don't re-add `file:///*` to the manifest — it grants
  nothing.
- **Lint locally with `--self-hosted`**, otherwise `addons-linter` errors on
  `update_url`. A few `UNSAFE_VAR_ASSIGNMENT` warnings are known and harmless: the
  drawer's own markup is built with `innerHTML` from `escapeHtml`-ed values.
- **`data_collection_permissions: { required: ["none"] }`** is injected at build
  time (AMO requires it). True here: remarks leave only via clipboard/download.
