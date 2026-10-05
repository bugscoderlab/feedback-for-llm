#!/usr/bin/env node
/**
 * Rewrite updates.json so the release that was just published is the newest
 * entry, and stage the single file that gets published to the gh-pages branch.
 *
 * Firefox fetches this file from browser_specific_settings.gecko.update_url,
 * finds the highest version greater than the installed one, then downloads
 * update_link (a signed .xpi attached to a GitHub Release).
 *
 * Usage:  node gen-updates.mjs <version> [tag]
 *   <version>  extension version that was released   (e.g. 1.2.0)
 *   [tag]      git/release tag                       (default: v<version>)
 *
 * Writes:
 *   updates.json              committed record
 *   dist/pages/updates.json   published to gh-pages
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(here, "release.config.json"), "utf8"));

const version = process.argv[2];
if (!version) {
  console.error("usage: node gen-updates.mjs <version> [tag]");
  process.exit(1);
}
const tag = process.argv[3] ?? `v${version}`;

const updateLink =
  `https://github.com/${cfg.repo}/releases/download/${tag}/` +
  `${cfg.artifactBase}-${version}.xpi`;

let doc;
try {
  doc = JSON.parse(await readFile(join(here, "updates.json"), "utf8"));
} catch {
  doc = {};
}
doc.addons ??= {};
const addon = (doc.addons[cfg.addonId] ??= { updates: [] });
addon.updates = addon.updates.filter((u) => u.version !== version);
addon.updates.push({ version, update_link: updateLink });
addon.updates.sort((a, b) => compareVersions(b.version, a.version)); // newest first

const json = JSON.stringify(doc, null, 2) + "\n";
await writeFile(join(here, "updates.json"), json);

const pagesDir = join(here, "dist", "pages");
await mkdir(pagesDir, { recursive: true });
await writeFile(join(pagesDir, "updates.json"), json);

console.log(`updates.json → ${cfg.addonId} ${version}`);
console.log(`  update_link: ${updateLink}`);

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
