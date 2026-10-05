#!/usr/bin/env node
/**
 * Guard against "hidden" classes that nothing hides, per ELEMENT.
 *
 * The v1.0.1 release shipped a half-fix: the FAB got `class="ffab-hidden"` but
 * no `#ffab-fab.ffab-hidden` rule existed, so the button stayed visible on every
 * page. A class-only check passes on that bug, because OTHER elements do have
 * hide rules for the same class name. The check must therefore pair each element
 * (its id) with the class applied to it.
 *
 * Checks:
 *   1. for every element with an id that carries a `*-hidden` class, some CSS
 *      rule targeting that id + class must set display:none / visibility:hidden
 *   2. CSS braces are balanced (a truncated rule silently kills later rules)
 *
 * Usage:  node check-hidden.mjs            # checks src/
 *         node check-hidden.mjs --dir <path>
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dirFlag = process.argv.indexOf("--dir");
const target = resolve(here, dirFlag !== -1 ? process.argv[dirFlag + 1] : "src");

const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
const files = [
  ...(manifest.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
  ...Object.values(manifest.background?.scripts ?? []),
];

const [js, css] = await Promise.all([
  Promise.all(files.filter((f) => f.endsWith(".js")).map((f) => readFile(join(target, f), "utf8"))).then((a) => a.join("\n")),
  Promise.all(files.filter((f) => f.endsWith(".css")).map((f) => readFile(join(target, f), "utf8"))).then((a) => a.join("\n")),
]);

const problems = [];

// Elements with an id AND a *-hidden class in their markup.
// Handles both attribute orders: id="x" class="y" / class="y" id="x".
const elements = [];
for (const tag of js.matchAll(/<[a-z][^>]*>/gi)) {
  const html = tag[0];
  const id = html.match(/\bid="([^"]+)"/)?.[1];
  const classAttr = html.match(/\bclass="([^"]+)"/)?.[1];
  if (!id || !classAttr) continue;
  for (const cls of classAttr.split(/\s+/).filter((c) => c.endsWith("-hidden"))) {
    elements.push({ id, cls, html });
  }
}

// Dedupe (the FAB markup appears once, but templates may repeat).
const seen = new Set();
for (const { id, cls, html } of elements) {
  const key = `${id}.${cls}`;
  if (seen.has(key)) continue;
  seen.add(key);

  // Rules whose selector mentions BOTH the element id and the class.
  const escId = id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const escCls = cls.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  // Strip comments so a comment mentioning the selector can't satisfy the check.
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /([^{}]*)\{([^}]*)\}/g;

  let hides = false;
  let matchedSelector = null;
  for (const m of cssNoComments.matchAll(ruleRe)) {
    const [selector, body] = [m[1].trim(), m[2]];
    const selHasId = new RegExp(`#${escId}(?![\\w-])`).test(selector);
    const selHasCls = new RegExp(`\\.${escCls}(?![\\w-])`).test(selector);
    if (selHasId && selHasCls && /display\s*:\s*none|visibility\s*:\s*hidden/.test(body)) {
      hides = true;
      matchedSelector = selector;
      break;
    }
  }

  if (hides) {
    console.log(`  ok   #${id}.${cls} -> "${matchedSelector}"`);
  } else {
    problems.push(
      `#${id} carries class "${cls}" but no "#${id}.${cls}" rule sets display:none ` +
        `-> the element will stay visible.`,
    );
  }
}

// --- brace balance ------------------------------------------------------------
const open = (css.match(/{/g) ?? []).length;
const close = (css.match(/}/g) ?? []).length;
if (open !== close) problems.push(`CSS braces unbalanced: ${open} "{" vs ${close} "}"`);

if (problems.length) {
  console.error(`\ncheck-hidden: ${problems.length} problem(s) in ${target}`);
  for (const p of problems) console.error(`  FAIL ${p}`);
  process.exit(1);
}
console.log(`\ncheck-hidden: OK (${target}, ${seen.size} element/class pair(s) checked)`);
