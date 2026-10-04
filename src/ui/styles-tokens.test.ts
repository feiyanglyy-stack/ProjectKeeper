// The premise of the theme layer (Spec §6.16; CKC-09 AC-40; the UI line's decision V3): every colour, shadow, radius
// and font in ui/styles.css goes through a `--pk-*` token with the factory value as its fallback, and the factory skin
// defines no token, so the factory look cannot differ from the fallbacks. This test keeps that premise: no bare colour
// literal outside a var() fallback, and no custom property without the `pk-` prefix, because the frozen themes define
// `--bg`, `--line`, `--amber` and the like with other meanings (ui/themes/TOKENS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const css = readFileSync(join(uiDir, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The stylesheet with every var(...) expression, nested fallbacks included, taken out. */
export function withoutVars(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('var(', i);
    if (at < 0) { out += text.slice(i); break; }
    out += text.slice(i, at);
    let depth = 0;
    let j = at + 3;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') { depth--; if (depth === 0) break; }
    }
    i = j + 1;
  }
  return out;
}

// A colour literal: hex, a colour function, or a named colour standing as a value (not `white-space`, not `.red`).
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?<![\w.-])(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|gold|pink|brown|navy|teal|olive|maroon|lime|aqua|fuchsia)(?![\w-])/;

test('every colour in styles.css sits in a var(--pk-…) fallback; none is bare', () => {
  const bare = withoutVars(css);
  // Declarations only: selectors carry class names like `.red`, which are not colours.
  const declarations = [...bare.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const offenders = declarations.flatMap((d) => d.split(';').map((s) => s.trim()).filter((s) => s && COLOUR.test(s.replace(/^[^:]+:/, ''))));
  assert.deepEqual(offenders, [], 'colour literals outside a var() fallback');
});

test('styles.css defines and reads only pk-prefixed custom properties', () => {
  const defined = [...css.matchAll(/(^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[2]);
  const read = [...css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  const wrong = [...new Set([...defined, ...read])].filter((name) => !name.startsWith('--pk-'));
  assert.deepEqual(wrong, [], 'custom properties without the pk- prefix');
  assert.ok(read.length > 250, `the sheet reads ${read.length} tokens; it used to read none`);
});

test('the pieces of the one card, the section head and the controls are tokens, so a theme gives every part the same treatment (Spec §6.16)', () => {
  for (const token of ['--pk-card-bg', '--pk-card-border', '--pk-card-shadow', '--pk-card-radius', '--pk-card-text', '--pk-card-texture', '--pk-head-bg', '--pk-head-text', '--pk-control-bg', '--pk-control-border', '--pk-well-bg', '--pk-text-strong', '--pk-graph-bg', '--pk-font-body', '--pk-font-mono']) {
    assert.ok(css.includes(`var(${token}`), `${token} is read by the sheet`);
  }
  // The popover, the docked Keeper, the dialog, the flyout and the open strip row all draw the card's background.
  for (const selector of ['.popover{', '.keeper-panel.docked{', 'dialog{', '.flyout{', '.strip-row.open{', '.note-card{']) {
    const rule = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
    assert.ok(rule.includes('var(--pk-card-bg'), `${selector} is the card`);
  }
});

test('the guard pins the shell only: no colour in it, and the layout invariants it restates', () => {
  const guard = readFileSync(join(uiDir, 'themes', 'guard.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(withoutVars(guard), COLOUR, 'the guard never says a colour');
  assert.doesNotMatch(guard, /var\(--pk-(?!keeper-w|dock-h|top|strip-h|rail-w|gap)/, 'the guard reads no colour token, only the layout sizes');
  for (const must of ['html,body{height:100%', '.shell{', '.body{', 'main{', '.keeper-panel.docked{', '.keeper-panel.floating{', 'header{position:static', '.popover{position:fixed', '.flyout{position:fixed', 'dialog{position:fixed']) {
    assert.ok(guard.replace(/\s+/g, '').includes(must.replace(/\s+/g, '')), `the guard restates ${must}`);
  }
});

test('the List by module (k-process.css) keeps the same premise, and its three layers read their own tokens (owner 2026-09-30)', () => {
  const kp = readFileSync(join(uiDir, 'k-process.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [...withoutVars(kp).matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const offenders = declarations.flatMap((d) => d.split(';').map((s) => s.trim()).filter((s) => s && COLOUR.test(s.replace(/^[^:]+:/, ''))));
  assert.deepEqual(offenders, [], 'colour literals outside a var() fallback');
  const names = [...new Set([...kp.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]))];
  assert.deepEqual(names.filter((n) => !n.startsWith('--pk-')), [], 'custom properties without the pk- prefix');
  // The plate (the Sign in card), the lane card (a module's head), the module's panel: each a set of tokens a theme fills.
  for (const token of ['--pk-plate-bg', '--pk-plate-texture', '--pk-plate-border', '--pk-plate-shadow', '--pk-plate-inlay', '--pk-plate-rivet', '--pk-plate-kicker', '--pk-slot-bg', '--pk-slot-text', '--pk-lane-bg', '--pk-lane-texture', '--pk-lane-border', '--pk-lane-corner', '--pk-lane-kicker', '--pk-lane-title', '--pk-lane-sub', '--pk-module-bg', '--pk-module-texture', '--pk-module-border']) {
    assert.ok(kp.includes(`var(${token}`), `${token} is read by the List`);
  }
  // Walnut fills every one of them; the other themes get the chain (section, raised face, accent).
  const a1 = readFileSync(join(uiDir, 'themes', 'a1', 'pk.css'), 'utf8');
  for (const token of ['--pk-plate-bg', '--pk-plate-rivet', '--pk-lane-texture', '--pk-lane-corner', '--pk-module-texture']) assert.match(a1, new RegExp(`${token}\s*:`), `a1 sets ${token}`);
});
