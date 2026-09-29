#!/usr/bin/env node
/**
 * patch8.mjs - act4embed, eighth round: the pop-up alert must show whenever the screen goes red.
 * Apply on top of the repo after patch7 (commit "Pop up alert", f6b0717).
 *
 *   Problem
 *     The page turns red and blinks (body[data-s=danger]) but the pop-up card never opens.
 *     The red page comes from "status", the pop-up is decided by a SECOND condition in
 *     static/alarm.js:   status === 'danger'  AND  (gas_alarm || vib_alarm)
 *     so the pop-up depends on two extra fields (gas_alarm, vib_alarm, vib_left) that only the
 *     newer app.py sends. If /data does not contain them (python app.py was not restarted after
 *     pulling / patching, an older copy is running, or the browser keeps an old alarm.js) the
 *     page still turns red but the pop-up stays hidden. On top of that, poll() swallowed EVERY
 *     error (also bugs inside update()) with "server unreachable", so it failed silently.
 *
 *   Fix
 *     static/alarm.js
 *       - The pop-up now opens whenever status === 'danger' (same trigger as the red screen).
 *       - If gas_alarm / vib_alarm are missing (older app.py) they are worked out from the
 *         readings (gas > threshold, vibration), and a console warning tells you to restart.
 *       - If neither reason is known, the card still opens and lists app.py's "reasons".
 *       - Errors inside the pop-up code are logged to the console instead of being hidden.
 *     templates/*.html
 *       - alarm.js and style.css version bumped v=6 -> v=8 so the browser fetches them again.
 *     app.py
 *       - "Simulate gas leak" also clears the "waiting for gas to drop" flag (gas_ack). Before,
 *         pressing Reset alarm and then Simulate gas leak again within 10 s was ignored.
 *
 * Usage (from the repo root, next to app.py):
 *     node patch8.mjs --dry-run   check only, writes nothing
 *     node patch8.mjs
 * If an anchor doesn't match, NOTHING is written. Backups go to .patch8-backup/
 * Undo with:  git checkout -- app.py static/alarm.js templates
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

if (load('static/alarm.js').text.includes('const legacy =')) { console.log('Already patched (patch8). Nothing to do.'); process.exit(0); }
if (!load('app.py').text.includes('sim_skip_warmup')) fail('app.py is missing patch7 (sim_skip_warmup). Apply patch7.mjs first.');
if (!load('app.py').text.includes('gas_latch')) fail('app.py is missing the pop-up backend (gas_latch, gas_alarm). Apply patch5.mjs first.');

/* =============================================================== static/alarm.js */
const JS = 'static/alarm.js';

// 1) a generic title for the "reason unknown" case
once(JS,
  `const TITLE = { gas: 'Gas detected', vib: 'Vibration detected', both: 'Gas and vibration detected' };`,
  `const TITLE = { gas: 'Gas detected', vib: 'Vibration detected', both: 'Gas and vibration detected', any: 'Alarm active' };`);

// 2) rows: no dangling " . " when a row has no sub-text
once(JS,
  `s.className = 'as'; s.textContent = ' \\u00b7 ' + sub;`,
  `s.className = 'as'; s.textContent = sub ? ' \\u00b7 ' + sub : '';`);

// 3) the trigger: same as the red screen (status === 'danger'), with a fallback for an older /data
once(JS,
  `  function update(d) {\n`
  + `    const g = !!d.gas_alarm, v = !!d.vib_alarm, on = d.status === 'danger' && (g || v);\n`,
  `  let warned = false;\n`
  + `\n`
  + `  function update(d) {\n`
  + `    // An older app.py sends no gas_alarm / vib_alarm: work them out from the readings instead.\n`
  + `    const legacy = d.gas_alarm === undefined && d.vib_alarm === undefined;\n`
  + `    if (legacy && !warned) { warned = true; console.warn('[alarm] /data has no gas_alarm / vib_alarm. Restart python app.py so the latest app.py is running.'); }\n`
  + `    const g = legacy ? (d.gas !== null && d.gas !== undefined && Number(d.gas) > Number(d.threshold)) : !!d.gas_alarm;\n`
  + `    const v = legacy ? !!d.vibration : !!d.vib_alarm;\n`
  + `    const on = d.status === 'danger';   // the pop-up opens exactly when the screen turns red\n`);

// 4) title + rows: cope with "reason unknown"
once(JS,
  `    title.textContent = TITLE[g && v ? 'both' : g ? 'gas' : 'vib'];\n`,
  `    title.textContent = TITLE[g && v ? 'both' : g ? 'gas' : v ? 'vib' : 'any'];\n`);

once(JS,
  `    rows.replaceChildren(...items);\n`,
  `    if (!items.length) items.push(row('Reason', (Array.isArray(d.reasons) && d.reasons.join('; ')) || 'An alarm is active', ''));\n`
  + `    rows.replaceChildren(...items);\n`);

// 5) poll(): a bug inside update() is no longer hidden behind "server unreachable"
once(JS,
  `    try {\n`
  + `      const r = await fetch('/data?since=1e18', { cache: 'no-store' });\n`
  + `      if (r.ok) update(await r.json());\n`
  + `    } catch (e) { /* server unreachable: keep the current pop-up state */ }\n`
  + `    finally { busy = false; }\n`,
  `    let d = null;\n`
  + `    try {\n`
  + `      const r = await fetch('/data?since=1e18', { cache: 'no-store' });\n`
  + `      if (r.ok) d = await r.json();\n`
  + `    } catch (e) { /* server unreachable: keep the current pop-up state */ }\n`
  + `    finally { busy = false; }\n`
  + `    if (d) { try { update(d); } catch (e) { console.error('[alarm] pop-up error:', e); } }\n`);

/* ================================================================== templates */
// 6) new version number so the browser does not keep an old alarm.js / style.css
for (const t of ['templates/index.html', 'templates/history.html', 'templates/settings.html']) {
  once(t, `/static/alarm.js?v=6`, `/static/alarm.js?v=8`);
  once(t, `/static/style.css?v=6`, `/static/style.css?v=8`);
}

/* ======================================================================= app.py */
// 7) the test button always alarms, even right after "Reset alarm"
once('app.py',
  `            ctrl["sim_skip_warmup"] = True     # test button: do not wait for the MQ-2 warm-up\n`,
  `            ctrl["sim_skip_warmup"] = True     # test button: do not wait for the MQ-2 warm-up\n`
  + `            ctrl["gas_ack"] = False            # test button: alarm again even right after "Reset alarm"\n`);

/* ---- write everything (or just report) */
const BAK = path.join(ROOT, '.patch8-backup');
for (const [rel, e] of out) {
  console.log((DRY ? 'would update ' : 'updating ') + rel);
  if (DRY) continue;
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(path.join(BAK, rel)), { recursive: true });
  fs.copyFileSync(p, path.join(BAK, rel));
  fs.writeFileSync(p, e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY
  ? '\nDry run OK. Run again without --dry-run to apply.'
  : '\nDone. Backups are in .patch8-backup/ (delete the folder when happy).\n'
  + 'Now: stop python app.py and start it again, then press Ctrl+F5 in the browser and press "Simulate gas leak".');
