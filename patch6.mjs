#!/usr/bin/env node
/**
 * patch6.mjs - act4embed, sixth round: alarm pop-up "Design 1" (classic card) on EVERY page.
 * Apply on top of the repo after patch5 (commit "add pop up msg on alert").
 *
 *   - static/alarm.js (new): the pop-up lives here and is loaded by Live, History and Settings.
 *     It polls /data by itself, so the pop-up also shows while you press the test buttons in Settings.
 *   - static/style.css: the glass-card pop-up is replaced by Design 1 (white card, red header,
 *     one row per sensor, red "Reset alarm" button) over a blinking red screen.
 *   - templates/index.html: the old inline pop-up (markup + JS) is removed.
 *   - all templates: alarm.js is loaded, and ?v=6 is added to the CSS/JS links so browsers do not
 *     keep an old cached copy.
 *
 * Usage (from the repo root, next to app.py):
 *     node patch6.mjs --dry-run   check only, writes nothing
 *     node patch6.mjs
 * If an anchor doesn't match, NOTHING is written. Undo with:  git checkout -- . && rm static/alarm.js
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

if (fs.existsSync(path.join(ROOT, 'static/alarm.js'))) { console.log('Already patched (patch6). Nothing to do.'); process.exit(0); }

const ALARM_JS = "/* Alarm pop-up (Design 1: classic card). Loaded on EVERY page, polls /data by itself.\n   Gas stays on until \"Reset alarm\"; vibration clears 1 min after the last vibration. */\n(function () {\n  const ICON = '<path d=\"M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6\"/><path d=\"M9 17v1a3 3 0 0 0 6 0v-1\"/><path d=\"M21 6.727a11.05 11.05 0 0 0 -2.794 -3.727\"/><path d=\"M3 6.727a11.05 11.05 0 0 1 2.792 -3.727\"/>';\n  const TITLE = { gas: 'Gas detected', vib: 'Vibration detected', both: 'Gas and vibration detected' };\n  const box = document.createElement('div');\n  box.className = 'alarm'; box.id = 'alarm'; box.hidden = true;\n  box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'aTitle');\n  box.innerHTML =\n    '<div class=\"acard\">' +\n      '<div class=\"ahead\"><svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">' + ICON + '</svg><span>Alarm</span></div>' +\n      '<div class=\"abody\"><h2 id=\"aTitle\"></h2><div id=\"aRows\"></div><button class=\"areset\" id=\"aReset\" type=\"button\">Reset alarm</button></div>' +\n    '</div>';\n  document.body.appendChild(box);\n  const rows = document.getElementById('aRows'), btn = document.getElementById('aReset'), title = document.getElementById('aTitle');\n  const fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');\n\n  function row(label, value, sub) {\n    const r = document.createElement('div'); r.className = 'arow';\n    const l = document.createElement('span'); l.className = 'al'; l.textContent = label;\n    const v = document.createElement('span'); v.className = 'av';\n    const b = document.createElement('b'); b.textContent = value;\n    const s = document.createElement('span'); s.className = 'as'; s.textContent = ' \\u00b7 ' + sub;\n    v.append(b, s); r.append(l, v); return r;\n  }\n\n  function update(d) {\n    const g = !!d.gas_alarm, v = !!d.vib_alarm, on = d.status === 'danger' && (g || v);\n    if (!on) {\n      if (!box.hidden) {\n        box.hidden = true; document.body.classList.remove('alarming');\n        document.querySelectorAll('header,main').forEach(e => { e.inert = false; });\n      }\n      return;\n    }\n    title.textContent = TITLE[g && v ? 'both' : g ? 'gas' : 'vib'];\n    const items = [];\n    if (g) items.push(row('Gas level', d.gas === null ? '--' : Number(d.gas), 'Limit ' + Number(d.threshold)));\n    if (v) items.push(row('Vibration', d.vibration ? 'Active' : 'Stopped', 'Off in ' + fmt(Number(d.vib_left) || 0)));\n    rows.replaceChildren(...items);\n    if (box.hidden) {\n      box.hidden = false; document.body.classList.add('alarming');\n      document.querySelectorAll('header,main').forEach(e => { e.inert = true; });\n      btn.focus();\n    }\n  }\n\n  let busy = false;\n  async function poll() {\n    if (busy) return; busy = true;\n    try {\n      const r = await fetch('/data?since=1e18', { cache: 'no-store' });\n      if (r.ok) update(await r.json());\n    } catch (e) { /* server unreachable: keep the current pop-up state */ }\n    finally { busy = false; }\n  }\n  btn.onclick = async () => {\n    btn.disabled = true;\n    try { await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset_alarm' }) }); } catch (e) {}\n    poll();\n    setTimeout(() => { btn.disabled = false; }, 1500);\n  };\n  poll(); setInterval(poll, 1000);\n})();\n";
const ALARM_CSS = "/* ambient-alarm: pop-up alert, Design 1 (classic card). Gas stays on until reset, vibration clears 1 min after it stops. */\nbody.alarming{overflow:hidden}\n@keyframes alarmblink{0%,100%{background:#a32d2d}50%{background:#5a1010}}\n.alarm{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;overflow:auto;background:#a32d2d;animation:alarmblink 1.2s ease-in-out infinite}\n.acard{width:100%;max-width:360px;background:#fff;color:#2c2c2a;border-radius:12px;overflow:hidden}\n.ahead{display:flex;align-items:center;gap:10px;background:#a32d2d;color:#fff;padding:12px 16px;font-weight:600}\n.abody{padding:16px}\n.acard h2{font:600 1.25rem/1.2 Figtree,system-ui,sans-serif;margin:0 0 10px;color:#2c2c2a;opacity:1}\n.arow{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid #d3d1c7;font-size:.9rem}\n.arow .al{color:#5f5e5a}\n.arow .av{text-align:right;font-variant-numeric:tabular-nums}\n.arow .av b{font-weight:600}\n.arow .as{color:#5f5e5a}\n.areset{width:100%;margin-top:14px;border:0;border-radius:8px;padding:11px;background:#a32d2d;color:#fff;font:600 1rem Figtree,system-ui,sans-serif;cursor:pointer}\n.areset:hover:not(:disabled){background:#8f2525}\n.areset:disabled{opacity:.6;cursor:default}\n@media(prefers-reduced-motion:reduce){.alarm{animation:none}}\n.areset:focus-visible{outline:3px solid #2c2c2a;outline-offset:2px}\n";

/* ---- static/style.css: swap the pop-up block */
{
  const e = load('static/style.css');
  const i = e.text.indexOf('/* ambient-alarm');
  if (i < 0) fail('static/style.css: pop-up block (ambient-alarm) not found. Is patch5 applied?');
  e.text = e.text.slice(0, i) + ALARM_CSS;
}

/* ---- templates/index.html: remove the old inline pop-up */
{
  const e = load('templates/index.html');
  const m = e.text.match(/<div class="alarm" id="alarm"[\s\S]*?\n<\/div>\n\n/);
  if (!m) fail('templates/index.html: old pop-up markup not found. Is patch5 applied?');
  e.text = e.text.replace(m[0], '');
  const a = e.text.indexOf('/* ---------- alarm pop-up ---------- */');
  const b = e.text.indexOf("$('muteBtn').onclick");
  if (a < 0 || b < 0 || b < a) fail('templates/index.html: old pop-up script not found.');
  e.text = e.text.slice(0, a) + e.text.slice(b);
  e.text = e.text.replace('  alarmUI(d);\n', '');
}

/* ---- every page: load alarm.js and bust the CSS cache */
for (const f of ['index', 'history', 'settings']) {
  const e = load('templates/' + f + '.html');
  if (!e.text.includes('href="/static/style.css"')) fail('templates/' + f + '.html: stylesheet link not found.');
  e.text = e.text.replace('href="/static/style.css"', 'href="/static/style.css?v=6"');
  if (!e.text.includes('</body>')) fail('templates/' + f + '.html: </body> not found.');
  e.text = e.text.replace('</body>', '<script src="/static/alarm.js?v=6"></script>\n</body>');
}

/* ---- write everything (or just report) */
for (const [rel, e] of out) {
  console.log((DRY ? 'would update ' : 'updating ') + rel);
  if (!DRY) fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log((DRY ? 'would create ' : 'creating ') + 'static/alarm.js');
if (!DRY) fs.writeFileSync(path.join(ROOT, 'static/alarm.js'), ALARM_JS);
console.log(DRY ? '\nDry run OK. Run again without --dry-run to apply.' : '\nDone. Restart python app.py and hard-refresh the browser (Ctrl+F5).');
