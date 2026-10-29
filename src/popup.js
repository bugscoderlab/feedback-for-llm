/* Popup shown on file:// tabs, where Firefox never lets extension content run
 * (verified against a signed permanent install: "Missing host permission for
 * the tab" regardless of file:///* in permissions or content_scripts.matches).
 * Nothing else about the click is special there — the honest UX is to explain
 * the platform restriction and hand over the exact commands that make the
 * page reviewable: serve the folder, open it over http. */
(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let cmds = "python3 -m http.server 8000\n# then open the page via http://localhost:8000/";
  if (tab?.url?.startsWith("file:")) {
    try {
      const path = decodeURIComponent(new URL(tab.url).pathname);
      const slash = path.lastIndexOf("/");
      const dir = path.slice(0, slash);
      const file = path.slice(slash + 1);
      cmds = `cd ${dir}\npython3 -m http.server 8000\n# then open:\nhttp://localhost:8000/${file}`;
    } catch {
      /* unusual file URL — keep the generic commands */
    }
  }
  document.getElementById("cmds").textContent = cmds;

  const btn = document.getElementById("copy");
  btn.addEventListener("click", async () => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(cmds);
    } catch {
      ok = false;
    }
    btn.textContent = ok ? "✓ Copied" : "⚠ Copy failed";
    setTimeout(() => (btn.textContent = "📋 Copy commands"), 1600);
  });
})();
