#!/usr/bin/env node
/**
 * patch3.mjs - act4embed, third round. Apply on top of the current repo (patch.mjs + patch2.mjs already applied).
 *
 *   - Arm button redesigned (clean pill, no white border), label is just "Arm" or "Disarm"
 *       green = system is armed (button says Disarm), red = system is disarmed (button says Arm)
 *   - Mouse wheel over a graph zooms in/out (no Ctrl needed), on the Live and History tabs
 *       Shift + wheel or a sideways trackpad swipe still scrolls the graph sideways
 *   - Dot removed beside "No vibration"
 *   - Headline ("All clear") + subtitle + the Arm button are centered
 *
 * Usage (from the repo root, next to app.py):
 *     node patch3.mjs --dry-run   check only, writes nothing
 *     node patch3.mjs
 * If an anchor doesn't match, NOTHING is written. Undo with:  git checkout -- .
 */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const out = new Map();

function fail(msg) { console.error('\nPATCH ABORTED, nothing was written.\n  ' + msg); process.exit(1); }

function load(rel) {
  if (out.has(rel)) return out.get(rel);
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(rel + ' not found. Run this from the repo root (next to app.py).');
  const raw = fs.readFileSync(p, 'utf8');
  const e = { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') };
  out.set(rel, e);
  return e;
}

function once(rel, find, repl) {
  const e = load(rel);
  const i = e.text.indexOf(find);
  if (i < 0) fail(rel + ': anchor not found:\n  ' + find.split('\n')[0].trim());
  if (e.text.indexOf(find, i + 1) >= 0) fail(rel + ': anchor is not unique:\n  ' + find.split('\n')[0].trim());
  e.text = e.text.slice(0, i) + repl + e.text.slice(i + find.length);
}

if (!load('templates/index.html').text.includes('id="gsc"')) fail('The zoomable graphs are missing. Apply patch.mjs and patch2.mjs first.');
if (load('static/style.css').text.includes('ambient-widgets-3')) { console.log('Already patched (patch3). Nothing to do.'); process.exit(0); }

/* ============================================================== style.css */
{
  const e = load('static/style.css');
  e.text = e.text.replace(/\s*$/, '\n') + String.raw`
/* ambient-widgets-3: centered headline, cleaner arm button */
.hero{text-align:center}
.hero .sub{margin:16px auto 0}
.hero .row{justify-content:center;margin-top:26px}
.btn.arm{border:0;border-radius:99px;min-width:180px;padding:14px 44px;color:var(--ink);font:800 1.1rem Figtree,system-ui,sans-serif;letter-spacing:.02em;box-shadow:0 6px 22px rgba(0,0,0,.28);transition:transform .15s,box-shadow .15s,background .3s}
.btn.arm.on{background:#4ade80;color:#04210f}
.btn.arm.off{background:#f87171;color:#2a0606}
.btn.arm:disabled{background:var(--glass);color:var(--ink);box-shadow:none}
.btn.arm:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 10px 26px rgba(0,0,0,.34)}
.btn.arm:active:not(:disabled){transform:translateY(1px);box-shadow:0 3px 12px rgba(0,0,0,.28)}
`;
}

/* ========================================================= templates/index.html */
once('templates/index.html',
  `  <section aria-live="polite">\n`,
  `  <section aria-live="polite" class="hero">\n`);

// no dot beside "No vibration"
once('templates/index.html',
  `<div class="state"><i class="dot" id="vibDot" aria-hidden="true"></i><span id="vibState">--</span></div>`,
  `<div class="state"><span id="vibState">--</span></div>`);
once('templates/index.html',
  `  $('vibDot').classList.toggle('on', d.vibration);\n`,
  ``);

// button text: just Arm / Disarm
once('templates/index.html',
  String.raw`  ab.textContent = armed ? 'Armed \u00b7 tap to disarm' : 'Disarmed \u00b7 tap to arm';`,
  `  ab.textContent = armed ? 'Disarm' : 'Arm';\n`
  + `  ab.setAttribute('aria-label', armed ? 'System is armed. Press to disarm' : 'System is disarmed. Press to arm');`);

// live: keep following the newest data while zooming with the wheel
once('templates/index.html',
  `const left = wasEnd && anchor === 1 ? L.total : L.x(tA) - anchor * cw;`,
  `const left = wasEnd ? L.total : L.x(tA) - anchor * cw;`);

once('templates/index.html',
  `Drag or swipe sideways for older data. Ctrl + mouse wheel or the +/- buttons zoom.`,
  `Mouse wheel over the graph zooms. Drag or swipe sideways for older data.`);

/* ======================================== plain mouse wheel = zoom (both pages) */
const WHEEL_OLD =
`  s.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;          // plain wheel keeps scrolling the page
    e.preventDefault();
    const r = s.getBoundingClientRect();
    setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), (e.clientX - r.left) / r.width);
  }, { passive: false });`;
const WHEEL_NEW =
`  s.addEventListener('wheel', e => {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // shift + wheel / sideways swipe = scroll
    e.preventDefault();                                                  // wheel = zoom at the pointer
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const r = s.getBoundingClientRect();
    setZoom(zoom * Math.exp(-dy * 0.002), (e.clientX - r.left) / r.width);
  }, { passive: false });`;
once('templates/index.html', WHEEL_OLD, WHEEL_NEW);
once('templates/history.html', WHEEL_OLD, WHEEL_NEW);

once('templates/history.html',
  `Drag or swipe sideways; Ctrl + mouse wheel or +/- to zoom.`,
  `Mouse wheel over the graph zooms; drag or swipe sideways to scroll.`);

/* ================================================================== write */
for (const [rel, e] of out) {
  const text = e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text;
  if (DRY) console.log('[dry-run] would patch', rel);
  else { fs.writeFileSync(path.join(ROOT, rel), text); console.log('patched', rel); }
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Restart the app:  python app.py   (then hard-refresh the browser: Ctrl+Shift+R)');
