/* Feedback for LLM — content script.
 *
 * A port of the annotation/feedback mode from docs/brief/prototype.html
 * (📝 Feedback for LLM): pick any element on the page, write what you want
 * changed, and export a markdown brief. Annotations persist per page in
 * browser.storage.local, so they survive reloads and browser restarts.
 */
(() => {
  if (window.__ffabLoaded) return;
  window.__ffabLoaded = true;

  /* ---------------- storage ---------------- */

  // remarks are scoped to one page (query params ignored — they rarely
  // change the layout, and it keeps one UI review per screen)
  const pageKey = `${location.origin}${location.pathname.replace(/\/+$/, "")}`;
  const storageKey = `ffab:${pageKey}`;

  let annotations = [];
  let seq = 1;

  async function load() {
    try {
      const raw = await browser.storage.local.get(storageKey);
      const rec = raw[storageKey];
      annotations = rec?.annotations ?? [];
      seq = rec?.seq ?? annotations.reduce((m, a) => Math.max(m, a.num || 0), 0) + 1;
    } catch {
      annotations = [];
    }
    render();
  }

  async function save() {
    try {
      await browser.storage.local.set({ [storageKey]: { annotations, seq } });
    } catch {
      // storage full or unavailable — remarks still live for this session
    }
  }

  /* ---------------- injected UI ---------------- */

  const UI = ["ffab-highlight", "ffab-pop", "ffab-drawer", "ffab-fab", "ffab-markers", "ffab-marker"];

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
      <div class="ffab-dr-actions">
        <button class="ffab-btn ffab-pick" id="ffab-dr-pick">🎯 Pick element on page</button>
        <button class="ffab-btn ffab-ghost" id="ffab-dr-copy">📋 Copy brief</button>
        <button class="ffab-btn ffab-ghost" id="ffab-dr-download">⬇ feedback.md</button>
        <button class="ffab-btn ffab-ghost" id="ffab-dr-clear">🗑 Clear all</button>
      </div>
      <div class="ffab-dr-list" id="ffab-dr-list"></div>
      <div class="ffab-dr-manual">
        <input id="ffab-dr-sel-input" placeholder="…or paste a CSS selector (from Firefox Inspect)">
        <button class="ffab-btn ffab-ghost" id="ffab-dr-sel-add">Attach</button>
      </div>
    </div>
    <button id="ffab-fab" class="ffab-hidden" title="Feedback for LLM">📝 Feedback <span class="ffab-cnt" id="ffab-cnt">0</span></button>
    <div id="ffab-markers"></div>`;
  // the page's own styles can be hostile — move UI to the top layer one node at a time
  while (root.firstElementChild) document.documentElement.appendChild(root.firstElementChild);

  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove("ffab-hidden");
  const hide = (el) => el.classList.add("ffab-hidden");

  /* ---------------- picking ---------------- */

  let picking = false;
  let pendingTarget = null; // {selector, label, content, docCtx} while the popover is open

  function startPicking() {
    picking = true;
    document.body.classList.add("ffab-annotating");
    // Picking replaces the panel with a crosshair, but the FAB stays as the
    // only visible status indicator (it pulses in ffab-picking) and the way out.
    show($("ffab-fab"));
    $("ffab-fab").classList.add("ffab-picking");
    $("ffab-dr-pick").classList.add("ffab-on");
    $("ffab-dr-pick").textContent = "🎯 Click an element… (Esc to cancel)";
    hide($("ffab-drawer"));
  }

  function stopPicking() {
    picking = false;
    document.body.classList.remove("ffab-annotating");
    $("ffab-fab").classList.remove("ffab-picking");
    $("ffab-dr-pick").classList.remove("ffab-on");
    $("ffab-dr-pick").textContent = "🎯 Pick element on page";
    hide($("ffab-highlight"));
  }

  function inUI(node) {
    return node instanceof Element && node.closest("#" + UI.join(", #"));
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!picking) return;
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
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!picking) return;
      if (inUI(e.target)) return; // let UI clicks through
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      pendingTarget = { selector: buildSelector(el), ...describeElement(el) };
      stopPicking();
      openPopover(e.clientX, e.clientY);
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (picking) stopPicking();
      closePopover();
    }
  });

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

  function render() {
    const open = annotations.filter((a) => a.status === "open").length;
    $("ffab-cnt").textContent = open;
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
      : `<div class="ffab-dr-empty">No remarks yet.<br>Click <b>🎯 Pick element on page</b>, then click anything — a field, a column, a button — and write what you want changed.<br><br>Or paste a CSS selector from Firefox Inspect below.</div>`;

    list.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", async () => {
        const a = annotations[+b.dataset.i];
        if (b.dataset.act === "del") annotations.splice(+b.dataset.i, 1);
        if (b.dataset.act === "resolve")
          a.status = a.status === "resolved" ? "open" : "resolved";
        if (b.dataset.act === "locate") {
          let el = null;
          try {
            el = document.querySelector(a.selector);
          } catch {
            /* fall through to the alert */
          }
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            const r = el.getBoundingClientRect();
            const h = $("ffab-highlight");
            h.style.left = `${r.left - 3}px`;
            h.style.top = `${r.top - 3}px`;
            h.style.width = `${r.width + 6}px`;
            h.style.height = `${r.height + 6}px`;
            show(h);
            setTimeout(() => {
              if (!picking) hide(h);
            }, 1600);
          } else {
            alert("Element not visible right now (view changed). The remark is still saved.");
          }
        }
        await save();
        render();
      })
    );

    renderMarkers();
  }

  /* ---------------- fab / drawer wiring ---------------- */

  // The FAB is not shown on page load — it appears only once the user opens the
  // panel from the toolbar button (or the in-page button, when visible), and is
  // hidden again when the panel closes. This keeps the host page clean.
  $("ffab-fab").addEventListener("click", () => {
    // While picking, a FAB click means "cancel" rather than "toggle panel".
    if (picking) {
      stopPicking();
      show($("ffab-drawer"));
      return;
    }
    setPanelOpen(!isPanelOpen());
  });
  $("ffab-dr-close").addEventListener("click", () => setPanelOpen(false));
  $("ffab-dr-pick").addEventListener("click", () => (picking ? stopPicking() : startPicking()));
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

  /** True when the feedback panel (drawer) is visible. */
  function isPanelOpen() {
    return !$("ffab-drawer").classList.contains("ffab-hidden");
  }

  /** Open/close the panel; the FAB visibility follows it. */
  function setPanelOpen(open) {
    if (open) {
      show($("ffab-drawer"));
      show($("ffab-fab"));
    } else {
      hide($("ffab-drawer"));
      hide($("ffab-fab"));
      stopPicking(); // leaving the panel should never strand the picker armed
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ffab:toggle") setPanelOpen(!isPanelOpen());
  });

  /* ---------------- brief export ---------------- */

  function feedbackText() {
    const open = annotations.filter((a) => a.status === "open");
    const L = [
      `# UI feedback — ${document.title || location.host}`,
      `Page: ${pageKey}`,
      `Exported: ${new Date().toLocaleString()} · ${open.length} open remark(s), ${annotations.length} total`,
      "",
    ];
    if (!annotations.length) L.push("(no remarks)");
    annotations.forEach((a) => {
      L.push(`## ${a.num}. [${a.status.toUpperCase()}] ${a.label}`);
      L.push(`- Where: ${a.docCtx}`);
      L.push(`- Selector: \`${a.selector}\``);
      if (a.content) L.push(`- Currently shows: "${a.content}"`);
      L.push("", "Requested change:", a.note, "");
    });
    L.push(
      "---",
      "_Generated by the Feedback for LLM Firefox extension. Act on OPEN remarks; RESOLVED ones are done._"
    );
    return L.join("\n");
  }

  function copyFeedback() {
    const t = feedbackText();
    const done = () => alert("Feedback brief copied — paste it to the LLM.");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(t).then(done, () => legacyCopy(t, done));
    } else {
      legacyCopy(t, done);
    }
  }

  function legacyCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
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
  $("ffab-dr-clear").addEventListener("click", async () => {
    if (!annotations.length) return;
    if (!confirm(`Delete all ${annotations.length} remark(s)? This cannot be undone.`)) return;
    annotations = [];
    seq = 1;
    await save();
    render();
  });

  /* ---------------- helpers ---------------- */

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  load();
})();
