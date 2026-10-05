#!/usr/bin/env node
/**
 * Assemble a release-ready copy of the "Feedback for LLM" extension.
 *
 *   1. copy src/ into dist/<artifactBase>/
 *   2. overlay the browser_specific_settings a signed, self-updating build needs
 *      (gecko.id, update_url, data_collection_permissions) — the source manifest
 *      in src/ stays clean for local `about:debugging` testing
 *   3. zip dist/<artifactBase>/ for manual install / AMO upload
 *   4. write dist/build-info.json so CI can read the version and names
 *   5. run check-hidden.mjs against the built bundle — refuses to ship a
 *      "hidden" class that no CSS rule actually hides (the v1.0.1 bug)
 *
 * Run from anywhere:  node build.mjs
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(here, "release.config.json"), "utf8"));

const sourceDir = resolve(here, cfg.sourceDir);
const distDir = join(here, "dist");
const outDir = join(distDir, cfg.artifactBase);

// Never ship VCS metadata, installed deps, or prior build output in the bundle.
const IGNORE = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "dist",
  "web-ext-artifacts",
]);

await rm(distDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(sourceDir, outDir, {
  recursive: true,
  filter: (src) => !IGNORE.has(basename(src)),
});

// --- release manifest overlay ------------------------------------------------
const manifestPath = join(outDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

manifest.browser_specific_settings ??= {};
manifest.browser_specific_settings.gecko ??= {};
const gecko = manifest.browser_specific_settings.gecko;

gecko.id = cfg.addonId;
// Required by AMO for new extensions (Firefox 140+ honours it; older Firefox
// simply ignores the key). Declares "this add-on transmits nothing".
gecko.data_collection_permissions = { required: ["none"] };
if (cfg.strictMinVersion) {
  gecko.strict_min_version = cfg.strictMinVersion;
}

if (cfg.channel === "listed") {
  // addons.mozilla.org owns updates for listed add-ons; update_url is rejected.
  delete gecko.update_url;
} else {
  gecko.update_url = cfg.updateUrl;
}

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// --- guard: fail on "hidden" classes nothing hides ---------------------------
// Run against the BUILT bundle (not src/) so it validates exactly what ships.
execFileSync("node", [join(here, "check-hidden.mjs"), "--dir", outDir], {
  stdio: "inherit",
});

// --- zip ---------------------------------------------------------------------
const version = manifest.version;
const zipName = `${cfg.artifactBase}-${version}.zip`;
const zipPath = join(distDir, zipName);
const entries = await readdir(outDir);
execFileSync("zip", ["-r", "-q", zipPath, ...entries], { cwd: outDir });

// --- build info for CI -------------------------------------------------------
const info = {
  version,
  artifactBase: cfg.artifactBase,
  addonId: cfg.addonId,
  channel: cfg.channel,
  updateUrl: cfg.channel === "listed" ? null : cfg.updateUrl,
  zip: zipName,
};
await writeFile(
  join(distDir, "build-info.json"),
  JSON.stringify(info, null, 2) + "\n",
);

console.log(`built ${cfg.artifactBase} ${version} → dist/${zipName}`);
console.log(`  addon id:   ${info.addonId}`);
console.log(`  channel:    ${info.channel}`);
console.log(`  update url: ${info.updateUrl ?? "(AMO-managed)"}`);
