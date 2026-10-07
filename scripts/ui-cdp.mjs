// A small driver for headless Chrome over the DevTools protocol (Node's own WebSocket, no dependency), for looking at
// the workbench in a real browser: real mouse and key events, measured rectangles, screenshots. The UI line's checks
// (scripts/ui-*-check.mjs) are written on top of it. It only ever talks to the local server it is pointed at.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Chrome where each system usually has it; CHROME_PATH names another.
const CHROME = process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
};

export async function launch({ width = 1280, height = 800, mobile = false } = {}) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'pk-ui-'))}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(200); }
  }
  if (!target) { chrome.kill(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  const consoleLines = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') consoleLines.push(`exception: ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`);
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) consoleLines.push(`${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  // PK_THEME=a1 runs any check with that theme in force: the choice is written where the page reads it (ui/theme.js),
  // before each document's own scripts run. Unset, the page opens on its default. The theme batches each ran the
  // structure checks under their theme this way; a theme must change no rectangle and no behaviour.
  const theme = process.env.PK_THEME;
  if (theme !== undefined) await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('pk.theme', ${JSON.stringify(theme === 'factory' ? '' : theme)}); } catch {}` });
  const setViewport = (w, h, isMobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: isMobile });
  await setViewport(width, height, mobile);

  /** Evaluate an expression in the page (a promise is awaited) and return its value; a thrown error is rethrown here. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`page: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
    return r.result?.result?.value;
  };
  /** Wait until the expression is truthy in the page. */
  const waitFor = async (expression, { timeout = 8000, label = expression } = {}) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evaluate(expression).catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}`);
      await sleep(80);
    }
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const click = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
  const drag = async (x1, y1, x2, y2, steps = 8) => {
    await mouse('mouseMoved', x1, y1, { buttons: 0 });
    await mouse('mousePressed', x1, y1);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await mouse('mouseReleased', x2, y2);
  };
  /** The centre of the first element matching the selector (scrolled into view when asked). */
  const centreOf = (selector, { scroll = false } = {}) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; ${scroll ? "el.scrollIntoView({ block: 'center' });" : ''} const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const clickOn = async (selector, opts) => { const c = await centreOf(selector, opts); if (!c) throw new Error(`no element: ${selector}`); await click(c.x, c.y); return c; };
  const key = async (name, modifiers = 0) => {
    const k = KEYS[name] ?? { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: name };
    await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', modifiers, ...k });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
  };
  const type = (text) => send('Input.insertText', { text });
  const wheel = (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  const shot = async (file) => {
    mkdirSync(dirname(file), { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  const navigate = async (url) => { await send('Page.navigate', { url }); };
  const reducedMotion = (on) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
  const close = async () => { try { ws.close(); } catch { /* already closed */ } chrome.kill(); };
  return { send, evaluate, waitFor, click, clickOn, centreOf, drag, key, type, wheel, shot, navigate, setViewport, reducedMotion, close, consoleLines };
}

/** Page-side helpers a check can paste into `evaluate`: rectangles, intersection, the visible text boxes of a root. */
export const PAGE_HELPERS = `
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const hit = (a, b) => Boolean(a && b) && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const inside = (a, b) => Boolean(a && b) && a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
  /* Every rendered line box of text under root that is actually visible: clipped by its scrolling ancestors. */
  const textBoxes = (root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const host = n.parentElement;
      if (!host || host.closest('#keeper-dock, #keeper, #toast, dialog, .popover, .strip.has-sheet > section')) continue;
      const cs = getComputedStyle(host);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let p = host; p && p !== document.documentElement; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
          const pr = p.getBoundingClientRect();
          box = { left: Math.max(box.left, pr.left), top: Math.max(box.top, pr.top), right: Math.min(box.right, pr.right), bottom: Math.min(box.bottom, pr.bottom) };
        }
        if (box.right - box.left >= 1 && box.bottom - box.top >= 1) out.push({ ...box, text: n.nodeValue.trim().slice(0, 40) });
      }
    }
    return out;
  };
`;
