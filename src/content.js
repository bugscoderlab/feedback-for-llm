/* Feedback for LLM — content script.
 *
 * A port of the annotation/feedback mode from docs/brief/prototype.html
 * (📝 Feedback for LLM): pick any element on the page, write what you want
 * changed, and export a markdown brief. Annotations persist per page in
 * browser.storage.local, so they survive reloads and browser restarts.
 */
(() => {
  // Snapshot the previous instance's open surface BEFORE touching it: a re-run
  // must re-open whatever the reviewer had open (an update landing in an open
  // tab, the background injecting us on demand).
  const prevDrawer = document.getElementById("ffab-drawer");
  const prevFab = document.getElementById("ffab-fab");
  const reopenDrawer = !!prevDrawer && !prevDrawer.classList.contains("ffab-hidden");
  const reopenPill = reopenDrawer || (!!prevFab && !prevFab.classList.contains("ffab-hidden"));

  // A previous instance of this script can already live in this page:
  //  - Firefox does NOT re-inject content scripts into open tabs when the
  //    extension updates — the tab keeps the old instance, and its ffab:toggle
  //    listener dies with the old extension version.
  //  - the background also injects us on demand when a click races the page load.
  // Bailing out on a loaded-flag (the old behaviour) leaves such a tab with no
  // working listener — the "clicked the toolbar button, nothing happened" bug.
  // So retire the previous instance properly and re-arm against the live one.
  try {
    window.__ffabTeardown?.();
  } catch {
    // its extension APIs are already gone — nothing to remove
  }

  /* ---------------- storage ---------------- */

  // remarks are scoped to one page (query params ignored — they rarely
  // change the layout, and it keeps one UI review per screen)
  const pageKey = `${location.origin}${location.pathname.replace(/\/+$/, "")}`;
  const storageKey = `ffab:${pageKey}`;

  let annotations = [];
  let seq = 1;
  // elements flagged for removal — a plain hit-list, no note, no status
  let basket = [];
  // the walkthrough: the ordered run of elements the reviewer clicked through to
  // reach the problem, plus the prose that explains it. Positional rather than
  // numbered — step 2 is the second pick, so deleting one renumbers the rest.
  let steps = [];
  let review = "";
  // Set as soon as the reviewer changes anything. A storage read that resolves
  // after that must not lay the old record back on top of their change — which is
  // how "cleared" steps come back when an extension update re-injects this script
  // into an open tab and its load() lands while they are already clicking.
  let dirty = false;
  // …and the mirror of it: until the stored record has actually been read, the
  // arrays in hand are empty, so writing them would wipe the reviewer's record.
  let loaded = false;

  async function load() {
    let rec = null;
    try {
      const raw = await browser.storage.local.get(storageKey);
      rec = raw[storageKey];
    } catch {
      rec = null; // storage unavailable — nothing to restore
    }
    loaded = true;
    if (dirty) return; // the reviewer got there first — their state wins
    annotations = rec?.annotations ?? [];
    basket = rec?.basket ?? [];
    steps = rec?.steps ?? [];
    review = rec?.review ?? "";
    seq = rec?.seq ?? annotations.reduce((m, a) => Math.max(m, a.num || 0), 0) + 1;
    render();
  }

  async function save() {
    dirty = true;
    if (!loaded) return; // never write a record we have not read yet
    try {
      await browser.storage.local.set({
        [storageKey]: { annotations, seq, basket, steps, review },
      });
    } catch {
      // storage full or unavailable — remarks still live for this session
    }
  }

  /* ---------------- injected UI ---------------- */

  const UI = [
    "ffab-highlight",
    "ffab-pop",
    "ffab-drawer",
    "ffab-fab",
    "ffab-markers",
    "ffab-marker",
    "ffab-dr-steps",
    "ffab-dr-review",
  ];

  // Adopt a clean slate before injecting, covering whatever the teardown above
  // did not: an instance that died before storing its teardown, or UI a
  // same-version re-injection left behind. Leftovers are dangerous — older
  // nodes answer getElementById first, and this instance would render its
  // drawer list into a panel that stays unreachable until a page reload.
  document
    .querySelectorAll(UI.map((id) => `#${id}`).join(", "))
    .forEach((el) => el.remove());
  // …and clear pick modes the old instance may have left armed on the body,
  // which would otherwise strand the page in crosshair (or red/teal) mode.
  document.body?.classList.remove("ffab-annotating", "ffab-removing", "ffab-stepping");

  const root = document.createElement("div");
  root.innerHTML = `
    <div id="ffab-highlight" class="ffab-hidden"></div>
    <div id="ffab-pop" class="ffab-hidden">
      <div class="ffab-ctx" id="ffab-ap-ctx"></div>
      <div class="ffab-sel" id="ffab-ap-sel"></div>
      <textarea id="ffab-ap-note" placeholder="Describe the change you want, e.g. “make this column wider” or “move this field above the table”…"></textarea>
      <div class="ffab-row">
        <button class="ffab-btn ffab-ghost" id="ffab-ap-cancel">Cancel</button>
        <button class="ffab-btn ffab-primary" id="ffab-ap-save">💾 Save remark</button>
      </div>
    </div>
    <div id="ffab-drawer" class="ffab-hidden">
      <div class="ffab-dr-head">
        <h3>📝 Feedback for LLM</h3>
        <span class="ffab-x" id="ffab-dr-close">✕</span>
      </div>
      <div class="ffab-dr-pickers">
        <button class="ffab-btn ffab-pick" id="ffab-dr-pick">🎯 Pick element</button>
        <button class="ffab-btn ffab-del" id="ffab-dr-del">🚫 Remove element</button>
      </div>
      <div class="ffab-dr-walk">
        <button class="ffab-btn ffab-step" id="ffab-dr-step">🧭 Record steps</button>
      </div>
      <div class="ffab-dr-actions">
        <button class="ffab-btn ffab-ghost" id="ffab-dr-copy">📋 Copy</button>
        <button class="ffab-btn ffab-ghost" id="ffab-dr-download">⬇ feedback.md</button>
        <button class="ffab-btn ffab-ghost ffab-hidden" id="ffab-dr-clear">🗑 Clear all</button>
      </div>
      <div class="ffab-dr-steps ffab-hidden" id="ffab-dr-steps"></div>
      <div class="ffab-dr-review ffab-hidden" id="ffab-dr-review">
        <div class="ffab-rv-head">Review</div>
        <textarea id="ffab-dr-review-note" placeholder="What you were doing, what you expected, what happened — the agent reads this above your remarks."></textarea>
      </div>
      <div class="ffab-dr-basket ffab-hidden" id="ffab-dr-basket"></div>
      <div class="ffab-dr-list" id="ffab-dr-list"></div>
      <div class="ffab-dr-manual">
        <input id="ffab-dr-sel-input" placeholder="…or paste a CSS selector (from Firefox Inspect)">
        <button class="ffab-btn ffab-ghost" id="ffab-dr-sel-add">Attach</button>
      </div>
    </div>
    <button id="ffab-fab" class="ffab-hidden" title="Feedback for LLM"><span id="ffab-fab-label">📝 Feedback</span> <span class="ffab-cnt" id="ffab-cnt">0</span></button>
    <div id="ffab-markers"></div>`;
  // the page's own styles can be hostile — move UI to the top layer one node at a time
  while (root.firstElementChild) document.documentElement.appendChild(root.firstElementChild);

  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove("ffab-hidden");
  const hide = (el) => el.classList.add("ffab-hidden");

  /* ---------------- picking ---------------- */

  let pickMode = null; // null | "remark" | "remove" | "step"
  let pendingTarget = null; // {selector, label, content, docCtx} while the popover is open

  function startPicking(mode) {
    pickMode = mode;
    document.body.classList.add("ffab-annotating");
    if (mode === "remove") document.body.classList.add("ffab-removing");
    if (mode === "step") document.body.classList.add("ffab-stepping");
    // Picking replaces the panel with a crosshair, but the FAB stays as the
    // only visible status indicator (it pulses in ffab-picking, and counts the
    // run in step mode) and the way out.
    show($("ffab-fab"));
    $("ffab-fab").classList.add("ffab-picking");
    setPickButtons();
    hide($("ffab-drawer"));
    render(); // flip the FAB into basket-/step-counting mode
  }

  function stopPicking() {
    pickMode = null;
    document.body.classList.remove("ffab-annotating", "ffab-removing", "ffab-stepping");
    $("ffab-fab").classList.remove("ffab-picking");
    setPickButtons();
    hide($("ffab-highlight"));
    render(); // restore the FAB from its removal-counting mode
  }

  /** Reflect the armed pick mode on all three picker buttons (label + pressed style). */
  function setPickButtons() {
    const pick = $("ffab-dr-pick");
    const del = $("ffab-dr-del");
    const step = $("ffab-dr-step");
    pick.classList.toggle("ffab-on", pickMode === "remark");
    del.classList.toggle("ffab-on", pickMode === "remove");
    step.classList.toggle("ffab-on", pickMode === "step");
    pick.textContent =
      pickMode === "remark" ? "🎯 Click an element… (Esc to cancel)" : "🎯 Pick element";
    del.textContent =
      pickMode === "remove"
        ? "🚫 Click elements to remove… (Esc to finish)"
        : "🚫 Remove element";
    step.textContent =
      pickMode === "step"
        ? "🧭 Click each step… (Esc to write it down)"
        : "🧭 Record steps";
  }

  function inUI(node) {
    return node instanceof Element && node.closest("#" + UI.join(", #"));
  }

  function onPickHover(e) {
    if (!pickMode) return;
    if (inUI(e.target)) {
      hide($("ffab-highlight"));
      return;
    }
    const r = e.target.getBoundingClientRect();
    const h = $("ffab-highlight");
    h.style.left = `${r.left - 2}px`;
    h.style.top = `${r.top - 2}px`;
    h.style.width = `${r.width + 4}px`;
    h.style.height = `${r.height + 4}px`;
    show(h);
  }
  document.addEventListener("mousemove", onPickHover, true);

  function onPickClick(e) {
    if (!pickMode) return;
    if (inUI(e.target)) return; // let UI clicks through
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (pickMode === "remove") {
      // Removal is a hit-list: no popover, no note, and the picker stays armed
      // so a run of elements can be basketed in one pass.
      addToBasket(el);
      return;
    }
    if (pickMode === "step") {
      // Same idea for the walkthrough: each click appends the next step and the
      // picker stays armed, so a run is picked in one motion and Esc ends it.
      addStep(el);
      return;
    }
    pendingTarget = { selector: buildSelector(el), ...describeElement(el) };
    stopPicking();
    openPopover(e.clientX, e.clientY);
  }
  document.addEventListener("click", onPickClick, true);

  function onKeydown(e) {
    if (e.key === "Escape") {
      // A finished run is followed by writing, so Esc puts the drawer — and the
      // review box under the steps — in front of the reviewer instead of leaving
      // them on the bare crosshair with the pill as the only way back.
      if (pickMode === "step") {
        stopPicking();
        setDrawerOpen(true);
        return;
      }
      if (pickMode) stopPicking();
      closePopover();
    }
  }
  document.addEventListener("keydown", onKeydown);

  /* ---------------- removal basket ---------------- */

  async function addToBasket(el) {
    const selector = buildSelector(el);
    const already = basket.some((b) => b.selector === selector);
    if (!already) {
      basket.push({ selector, ...describeElement(el), at: new Date().toISOString() });
      await save();
    }
    render();
    // The drawer is hidden while picking, so the marker appearing on the element
    // is the confirmation that it was basketed — and on a repeat pick the same
    // marker pops again, so a duplicate click reads as "already in there".
    const marker = [...$("ffab-markers").children].find((m) => m.dataset.sel === selector);
    if (marker) {
      marker.classList.add("ffab-marker-pop");
      setTimeout(() => marker.classList.remove("ffab-marker-pop"), 400);
    }
  }

  /* ---------------- walkthrough steps ---------------- */

  async function addStep(el) {
    steps.push({ selector: buildSelector(el), ...describeElement(el), at: new Date().toISOString() });
    await save();
    render();
    // The drawer is hidden while picking, so the FAB counter ticking up is the
    // confirmation that a pick landed; the highlight pulses once too, so a step
    // taken on the element the cursor is already resting on still reads as
    // registered rather than as a click that went nowhere.
    const h = $("ffab-highlight");
    h.classList.remove("ffab-flash");
    void h.offsetWidth; // restart the animation for a back-to-back pick
    h.classList.add("ffab-flash");
    setTimeout(() => h.classList.remove("ffab-flash"), 400);
  }

  /* ---------------- selector & description ---------------- */

  function buildSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 4) {
      if (cur.id) {
        parts.unshift("#" + CSS.escape(cur.id));
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const stable = [...cur.classList].filter(
        (c) => !["ffab-hidden", "ffab-on", "ffab-picking", "ffab-current", "ffab-annotating"].includes(c)
      );
      if (stable.length) {
        parts.unshift(`${tag}.${stable.map((c) => CSS.escape(c)).join(".")}`);
      } else {
        const sibs = cur.parentElement
          ? [...cur.parentElement.children].filter((x) => x.tagName === cur.tagName)
          : [];
        const idx = Math.max(1, sibs.indexOf(cur) + 1);
        parts.unshift(`${tag}:nth-of-type(${idx})`);
      }
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function describeElement(el) {
    const docCtx = `${document.title || "(untitled)"} · ${location.host}${location.pathname}`;
    let label = el.tagName.toLowerCase();
    let content = "";
    const text = (el.textContent || "").trim();
    const aria = el.getAttribute("aria-label");
    const ph = el.getAttribute("placeholder");
    const title = el.getAttribute("title");

    const labelledById = el.getAttribute("aria-labelledby");
    const externalLabel = el.id
      ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      : null;

    if (aria) {
      label = `element “${aria}”`;
    } else if (labelledById && document.getElementById(labelledById)) {
      label = `element “${document.getElementById(labelledById).textContent.trim()}”`;
    } else if (externalLabel) {
      label = `field “${externalLabel.textContent.trim()}”`;
      content = text;
    } else if (el.tagName === "TH") {
      label = `column header “${text}”`;
    } else if (el.tagName === "BUTTON") {
      label = `button “${text}”`;
    } else if (el.tagName === "A" && text) {
      label = `link “${text.slice(0, 50)}${text.length > 50 ? "…" : ""}”`;
    } else if (/^H[1-6]$/.test(el.tagName)) {
      label = `heading “${text}”`;
    } else if (el.tagName === "IMG") {
      label = `image “${el.getAttribute("alt") || el.src.split("/").pop()}”`;
    } else {
      const wrap = el.closest("label, .fld, .field, .form-field, [data-field-label]");
      const wrapLabel = wrap
        ? (wrap.getAttribute("data-field-label") ||
           wrap.querySelector("label")?.textContent ||
           wrap.textContent).trim().slice(0, 40)
        : null;
      if (wrapLabel) {
        label = `field “${wrapLabel}”`;
        content = text;
      } else if (ph) {
        label = `input “${ph}”`;
      } else if (title) {
        label = `element “${title}”`;
      } else if (text && text.length < 90) {
        label = `text “${text.slice(0, 50)}${text.length > 50 ? "…" : ""}”`;
        content = text.slice(0, 120);
      }
    }
    return { docCtx, label, content: (content || "").slice(0, 140) };
  }

  /* ---------------- popover ---------------- */

  function openPopover(x, y) {
    $("ffab-ap-ctx").innerHTML =
      `<b>${escapeHtml(pendingTarget.label)}</b><br>${escapeHtml(pendingTarget.docCtx)}` +
      (pendingTarget.content
        ? `<br>shows: “${escapeHtml(pendingTarget.content.slice(0, 60))}”`
        : "");
    $("ffab-ap-sel").textContent = pendingTarget.selector;
    $("ffab-ap-note").value = "";
    show($("ffab-pop"));
    const pw = 340;
    const ph = 300;
    $("ffab-pop").style.left = `${Math.min(x, innerWidth - pw - 16)}px`;
    $("ffab-pop").style.top = `${Math.min(y, innerHeight - ph - 16)}px`;
    setTimeout(() => $("ffab-ap-note").focus(), 50);
  }

  function closePopover() {
    hide($("ffab-pop"));
    pendingTarget = null;
  }

  $("ffab-ap-cancel").addEventListener("click", closePopover);
  $("ffab-ap-save").addEventListener("click", async () => {
    const note = $("ffab-ap-note").value.trim();
    if (!note || !pendingTarget) return;
    annotations.push({ num: seq++, status: "open", note, ...pendingTarget, at: new Date().toISOString() });
    await save();
    closePopover();
    render();
  });

  /* ---------------- markers ---------------- */

  function renderMarkers() {
    const box = $("ffab-markers");
    box.innerHTML = "";
    annotations.forEach((a) => {
      let el = null;
      try {
        el = document.querySelector(a.selector);
      } catch {
        /* invalid selector — marker skipped */
      }
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const m = document.createElement("div");
      m.className = "ffab-marker" + (a.status === "resolved" ? " ffab-resolved" : "");
      m.textContent = a.num;
      m.title = a.note;
      m.style.left = `${Math.min(r.right, innerWidth - 10)}px`;
      m.style.top = `${Math.max(r.top, 14)}px`;
      m.addEventListener("click", () => show($("ffab-drawer")));
      box.appendChild(m);
    });
    // basket items get their own ✕ badge so marked-for-removal elements are
    // readable at a glance, distinct from the numbered remark markers
    basket.forEach((b) => {
      let el = null;
      try {
        el = document.querySelector(b.selector);
      } catch {
        /* invalid selector — marker skipped */
      }
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const m = document.createElement("div");
      m.className = "ffab-marker ffab-marker-del";
      m.textContent = "✕";
      m.title = `Remove: ${b.label || b.selector}`;
      m.dataset.sel = b.selector;
      m.style.left = `${Math.min(r.right, innerWidth - 10)}px`;
      m.style.top = `${Math.max(r.top, 14)}px`;
      m.addEventListener("click", () => show($("ffab-drawer")));
      box.appendChild(m);
    });
  }

  let markersQueued = false;
  function queueMarkers() {
    if (markersQueued) return;
    markersQueued = true;
    requestAnimationFrame(() => {
      markersQueued = false;
      renderMarkers();
    });
  }
  document.addEventListener("scroll", queueMarkers, { capture: true, passive: true });
  addEventListener("resize", queueMarkers);

  /* ---------------- drawer ---------------- */

  /** Clear all is offered only when there is something to clear. */
  function syncClearAll() {
    const any = !!(annotations.length || basket.length || steps.length || review.trim());
    if (!any) disarmClear(); // a hidden button must not come back armed
    $("ffab-dr-clear").classList.toggle("ffab-hidden", !any);
  }

  /** Scroll an element into view and flash the highlight on it. */
  function locate(selector, btn) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {
      /* handled below — the selector no longer resolves */
    }
    if (!el) {
      // The view changed under the annotation. Say so on the button that asked,
      // for the same reason Copy does: a dialog here is one more modal, and a page
      // that shows a few of them has its dialogs suppressed without a word.
      if (btn) flashButton(btn, "⌖ not here", false);
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const r = el.getBoundingClientRect();
    const h = $("ffab-highlight");
    h.style.left = `${r.left - 3}px`;
    h.style.top = `${r.top - 3}px`;
    h.style.width = `${r.width + 6}px`;
    h.style.height = `${r.height + 6}px`;
    show(h);
    setTimeout(() => {
      if (!pickMode) hide(h);
    }, 1600);
  }

  function render() {
    const removing = pickMode === "remove";
    const stepping = pickMode === "step";
    const open = annotations.filter((a) => a.status === "open").length;
    // While removal-/step-picking, the FAB becomes that run's live counter — the
    // drawer is hidden at that point, so it is the only running feedback.
    $("ffab-fab-label").textContent = removing
      ? "🚫 Remove"
      : stepping
        ? "🧭 Steps"
        : "📝 Feedback";
    $("ffab-cnt").textContent = removing ? basket.length : stepping ? steps.length : open;
    syncClearAll();
    try {
      browser.runtime.sendMessage({ type: "ffab:badge", count: open });
    } catch {
      /* background unreachable — badge is cosmetic */
    }

    const list = $("ffab-dr-list");
    list.innerHTML = annotations.length
      ? annotations
          .map(
            (a, i) => `
      <div class="ffab-ann ${a.status === "resolved" ? "ffab-resolved" : ""}">
        <div class="ffab-ann-top">
          <span class="ffab-n">${a.num}</span>
          <span class="ffab-ann-label">${escapeHtml(a.label)}</span>
          <span class="ffab-badge ${a.status === "resolved" ? "ffab-b-ok" : "ffab-b-review"}">${a.status}</span>
        </div>
        <div class="ffab-ann-sel">${escapeHtml(a.selector)}</div>
        <div class="ffab-ann-quote">${escapeHtml(a.docCtx)}${a.content ? ` · shows “${escapeHtml(a.content.slice(0, 60))}”` : ""}</div>
        <div class="ffab-ann-note">${escapeHtml(a.note)}</div>
        <div class="ffab-ann-tools">
          <button data-act="locate" data-i="${i}">⌖ locate</button>
          <button data-act="resolve" data-i="${i}">${a.status === "resolved" ? "↩ reopen" : "✓ resolve"}</button>
          <button data-act="del" data-i="${i}">🗑 delete</button>
        </div>
      </div>`
          )
          .join("")
      : `<div class="ffab-dr-empty">No remarks yet.<br>Click <b>🎯 Pick element</b>, then click anything — a field, a column, a button — and write what you want changed.<br><br>To explain the run that got you here, use <b>🧭 Record steps</b> — click element after element, then Esc and write your review.<br><br>To delete elements instead, use <b>🚫 Remove element</b> — picks drop straight into the removal basket.<br><br>Or paste a CSS selector from Firefox Inspect below.</div>`;

    list.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", async () => {
        const a = annotations[+b.dataset.i];
        if (b.dataset.act === "del") annotations.splice(+b.dataset.i, 1);
        if (b.dataset.act === "resolve")
          a.status = a.status === "resolved" ? "open" : "resolved";
        if (b.dataset.act === "locate") {
          locate(a.selector, b);
          return; // nothing changed — no save, no re-render
        }
        await save();
        render();
      })
    );

    renderSteps();
    renderBasket();

    renderMarkers();
  }

  /**
   * The walkthrough: the ordered run of picks, with the review box that explains
   * it right underneath. Rows reuse the basket's row classes — the two lists are
   * structurally the same thing, one red and one teal.
   */
  function renderSteps() {
    const box = $("ffab-dr-steps");
    const has = !!steps.length;
    box.classList.toggle("ffab-hidden", !has);
    // The review box is static markup, so typing in it survives a re-render —
    // never overwrite it while the reviewer is in it. It stays visible when steps
    // were cleared but words are still there, so nothing can be lost out of sight.
    $("ffab-dr-review").classList.toggle("ffab-hidden", !has && !review.trim());
    const ta = $("ffab-dr-review-note");
    if (document.activeElement !== ta && ta.value !== review) ta.value = review;

    if (!has) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      `<div class="ffab-st-head">
         <span class="ffab-st-title">🧭 Steps to reproduce (${steps.length})</span>
         <button class="ffab-st-clear" data-act="steps-clear">clear</button>
       </div>` +
      steps
        .map(
          (s, i) => `
      <div class="ffab-bk-row">
        <span class="ffab-st-n">${i + 1}</span>
        <div class="ffab-bk-main">
          <span class="ffab-bk-label">${escapeHtml(s.label)}</span>
          <span class="ffab-bk-sel">${escapeHtml(s.selector)}</span>
        </div>
        <button class="ffab-bk-x" data-act="step-locate" data-i="${i}" title="Show me">⌖</button>
        <button class="ffab-bk-x" data-act="step-del" data-i="${i}" title="Remove step">✕</button>
      </div>`
        )
        .join("");

    box.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", async () => {
        if (b.dataset.act === "steps-clear") steps = [];
        else if (b.dataset.act === "step-del") steps.splice(+b.dataset.i, 1);
        else if (b.dataset.act === "step-locate") {
          locate(steps[+b.dataset.i]?.selector, b);
          return; // showing beats telling — nothing to save
        }
        await save();
        render();
      })
    );
  }

  /** The removal basket: a compact hit-list above the remarks, no notes involved. */
  function renderBasket() {
    const box = $("ffab-dr-basket");
    box.classList.toggle("ffab-hidden", !basket.length);
    if (!basket.length) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      `<div class="ffab-bk-head">
         <span class="ffab-bk-title">🚫 Remove these elements (${basket.length})</span>
         <button class="ffab-bk-clear" data-act="basket-clear">clear</button>
       </div>` +
      basket
        .map(
          (b, i) => `
      <div class="ffab-bk-row">
        <div class="ffab-bk-main">
          <span class="ffab-bk-label">${escapeHtml(b.label)}</span>
          <span class="ffab-bk-sel">${escapeHtml(b.selector)}</span>
        </div>
        <button class="ffab-bk-x" data-act="basket-del" data-i="${i}" title="Remove from basket">✕</button>
      </div>`
        )
        .join("");

    box.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", async () => {
        if (b.dataset.act === "basket-clear") basket = [];
        else basket.splice(+b.dataset.i, 1);
        await save();
        render();
      })
    );
  }

  /* ---------------- pill / drawer wiring ---------------- */

  // The toolbar button puts only the pill on the page; the drawer opens from the
  // pill and from nowhere else. Both are gone on page load, so the host page is
  // untouched until the reviewer asks for the pill.
  $("ffab-fab").addEventListener("click", () => {
    // While picking, a pill click means "cancel" rather than "toggle the drawer".
    if (pickMode) {
      stopPicking();
      setDrawerOpen(true);
      return;
    }
    setDrawerOpen(!isDrawerOpen());
  });
  $("ffab-dr-close").addEventListener("click", () => setDrawerOpen(false));
  $("ffab-dr-pick").addEventListener("click", () =>
    pickMode === "remark" ? stopPicking() : startPicking("remark")
  );
  $("ffab-dr-del").addEventListener("click", () =>
    pickMode === "remove" ? stopPicking() : startPicking("remove")
  );
  $("ffab-dr-step").addEventListener("click", () =>
    pickMode === "step" ? stopPicking() : startPicking("step")
  );
  // The review is typed straight into the static box: the words live in `review`
  // as they are typed (so Copy/export is never stale), and persistence is
  // debounced so a sentence is not one storage write per keystroke.
  let reviewSaveTimer = null;
  $("ffab-dr-review-note").addEventListener("input", (e) => {
    review = e.target.value;
    syncClearAll();
    clearTimeout(reviewSaveTimer);
    reviewSaveTimer = setTimeout(save, 300);
  });
  $("ffab-dr-review-note").addEventListener("blur", () => {
    clearTimeout(reviewSaveTimer);
    save();
  });
  $("ffab-dr-sel-add").addEventListener("click", () => {
    const sel = $("ffab-dr-sel-input").value.trim();
    if (!sel) return;
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch {
      /* fall through — attach anyway with a placeholder label */
    }
    pendingTarget = el
      ? { selector: sel, ...describeElement(el) }
      : { selector: sel, docCtx: "(selector from Inspector)", label: "element (not currently rendered)", content: "" };
    $("ffab-dr-sel-input").value = "";
    openPopover(innerWidth / 2 - 170, innerHeight / 2 - 150);
  });

  /** True when the drawer (the panel itself, not the pill) is visible. */
  function isDrawerOpen() {
    return !$("ffab-drawer").classList.contains("ffab-hidden");
  }

  /** Open/close the drawer alone — the pill stays put as the way back in. */
  function setDrawerOpen(open) {
    if (open) {
      show($("ffab-drawer"));
      show($("ffab-fab")); // the pill is the drawer's handle, so it is always there
    } else {
      hide($("ffab-drawer"));
      stopPicking(); // closing the drawer should never strand the picker armed
    }
  }

  function onRuntimeMessage(msg) {
    // Toolbar button: bring out the pill by itself, or put everything away.
    if (msg.type === "ffab:toggle") {
      if (isPillVisible()) {
        setDrawerOpen(false);
        hide($("ffab-fab"));
      } else {
        setDrawerOpen(false);
        show($("ffab-fab"));
      }
    }
  }
  browser.runtime.onMessage.addListener(onRuntimeMessage);

  /** True when the pill is on the page. */
  function isPillVisible() {
    return !$("ffab-fab").classList.contains("ffab-hidden");
  }

  /* ---------------- brief export ---------------- */

  function feedbackText() {
    const open = annotations.filter((a) => a.status === "open");
    const L = [
      `# UI feedback — ${document.title || location.host}`,
      `Page: ${pageKey}`,
      `Exported: ${new Date().toLocaleString()} · ${open.length} open remark(s), ${annotations.length} total` +
        (steps.length ? ` · ${steps.length} step(s) to reproduce` : "") +
        (basket.length ? ` · ${basket.length} element(s) to remove` : ""),
      "",
    ];
    // The run that got the reviewer here comes first, so the agent reads the
    // journey before the individual requests.
    if (steps.length) {
      L.push(`## Steps to reproduce`, "");
      steps.forEach((s, i) => L.push(`${i + 1}. ${s.label} — \`${s.selector}\``));
      L.push("");
      if (review.trim()) L.push("Review:", review.trim(), "");
    }
    if (!annotations.length) L.push("(no remarks)");
    annotations.forEach((a) => {
      L.push(`## ${a.num}. [${a.status.toUpperCase()}] ${a.label}`);
      L.push(`- Where: ${a.docCtx}`);
      L.push(`- Selector: \`${a.selector}\``);
      if (a.content) L.push(`- Currently shows: "${a.content}"`);
      L.push("", "Requested change:", a.note, "");
    });
    if (basket.length) {
      L.push(`## Remove these elements`, "");
      basket.forEach((b) => {
        L.push(`- \`${b.selector}\`${b.label ? ` — ${b.label}` : ""}`);
      });
      L.push("");
    }
    L.push(
      "---",
      "_Generated by the Feedback for LLM Firefox extension. Act on OPEN remarks; RESOLVED ones are done._"
    );
    return L.join("\n");
  }

  function copyFeedback() {
    const t = feedbackText();
    // No dialog: the button that was clicked reports the result itself, so the
    // page never gets a modal to dismiss and the reviewer keeps clicking.
    const report = (ok) => flashButton($("ffab-dr-copy"), ok ? "✓ Copied" : "⚠ Copy failed", ok);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(t).then(() => report(true), () => report(legacyCopy(t)));
    } else {
      report(legacyCopy(t));
    }
  }

  /** Say what just happened on the button that caused it, then put its label back. */
  function flashButton(btn, label, ok) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = label;
    btn.classList.add(ok ? "ffab-flash-ok" : "ffab-flash-bad");
    clearTimeout(btn.__ffabFlash);
    btn.__ffabFlash = setTimeout(() => {
      btn.textContent = btn.dataset.label;
      btn.classList.remove("ffab-flash-ok", "ffab-flash-bad");
    }, 1600);
  }

  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }

  function downloadFeedback() {
    const blob = new Blob([feedbackText()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `feedback-${location.hostname}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $("ffab-dr-copy").addEventListener("click", copyFeedback);
  $("ffab-dr-download").addEventListener("click", downloadFeedback);
  // Clearing everything is destructive, but confirm() is the wrong tool for it:
  // Firefox stops showing dialogs for a page that has already shown a few, and a
  // suppressed confirm() returns false with nothing on screen to explain it — the
  // button looks broken from then on. The alert that Copy used to raise was enough
  // to get the page there. So the button asks in place instead: the first click
  // arms it, the second clears, and it stands down on its own.
  let clearArmed = false;
  let clearArmTimer = null;

  function disarmClear() {
    clearArmed = false;
    clearTimeout(clearArmTimer);
    const btn = $("ffab-dr-clear");
    btn.textContent = "🗑 Clear all";
    btn.classList.remove("ffab-arm");
  }

  $("ffab-dr-clear").addEventListener("click", async () => {
    const btn = $("ffab-dr-clear");
    const empty = !annotations.length && !basket.length && !steps.length && !review.trim();
    if (empty) return;
    if (!clearArmed) {
      clearArmed = true;
      btn.textContent = "🗑 Sure? Click again";
      btn.classList.add("ffab-arm");
      clearTimeout(clearArmTimer);
      clearArmTimer = setTimeout(disarmClear, 4000);
      return;
    }
    annotations = [];
    basket = [];
    steps = [];
    review = "";
    seq = 1;
    $("ffab-dr-review-note").value = "";
    disarmClear();
    await save();
    render();
  });

  /* ---------------- helpers ---------------- */

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Reinstate the surface the previous instance had open, so an update landing in
  // an open tab swaps the buttons underneath the user instead of closing the panel.
  if (reopenDrawer) setDrawerOpen(true);
  else if (reopenPill) show($("ffab-fab"));

  /* Retire this instance when the script is injected again into this page
   * (extension update, or the background's on-demand injection): drop every
   * listener we registered plus our UI, so exactly one live ffab:toggle
   * listener exists per page and stale nodes never shadow new ones. */

  function teardown() {
    try {
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // the extension context is already gone — nothing to remove
    }
    document.removeEventListener("mousemove", onPickHover, true);
    document.removeEventListener("click", onPickClick, true);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("scroll", queueMarkers, { capture: true });
    removeEventListener("resize", queueMarkers);
    document
      .querySelectorAll(UI.map((id) => `#${id}`).join(", "))
      .forEach((el) => el.remove());
    document.body?.classList.remove("ffab-annotating", "ffab-removing", "ffab-stepping");
    if (window.__ffabTeardown === teardown) delete window.__ffabTeardown;
  }
  window.__ffabTeardown = teardown;

  load();
})();
