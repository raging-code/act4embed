#!/usr/bin/env node
/**
 * patch12.mjs - act4embed, twelfth round: after "Reset alarm" the page must go back to its normal colour.
 * Apply on top of patch11 (commit "Pop up", 665a8b2).
 *
 * WHY THE COLOUR DID NOT GO BACK
 *   After Reset the alarm is over (red is gone), but while the gas is still above 70 % of the threshold the
 *   server reported status "warning", which is the amber/brown theme. In the simulator (and with a real MQ-2,
 *   which stays high for a while) that lasted many seconds, so the page looked "stuck" in a different colour.
 *
 * WHAT CHANGES
 *   app.py       Reset now acknowledges the gas warning too (new ctrl "warn_ack"): status goes straight to
 *                "safe" (normal colour) and stays there until the gas has really fallen to <= 70 % of the
 *                threshold once. A new alarm (gas > threshold) still turns the page red as before.
 *   index.html   The "Gas is still high - the alarm was reset..." message is kept, but now shown with the
 *                normal colour (status "safe") instead of the amber one.
 *   alarm.js     Also sets the page colour from every poll, so the colour changes the moment you press Reset
 *                (no waiting for the page's own 1 s poll) and the History page follows the status too.
 *   templates    alarm.js?v=9 -> ?v=10 so browsers load the new file.
 *
 *   Files changed: app.py, static/alarm.js, templates/index.html, templates/history.html, templates/settings.html
 *
 * Usage (from the repo root, next to app.py):
 *     node patch12.mjs --dry-run   check only, writes nothing
 *     node patch12.mjs
 * If an anchor doesn't match, NOTHING is written. Backups go to .patch12-backup/
 * Undo with:  git checkout -- app.py static/alarm.js templates
 * Then restart the app (stop the old python first!) and hard-refresh the browser (Ctrl+F5).
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
  const e = { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n'), raw };
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

const app0 = load('app.py').text;
if (app0.includes('"warn_ack"')) { console.log('Already patched (patch12). Nothing to do.'); process.exit(0); }
if (!app0.includes('"vib_wait"')) fail('app.py is not the patch11 version. Pull the latest repo (git pull) first.');

/* ================================================================ app.py */

// 1) new control field
once('app.py',
`        "gas_ok_since": None} # since when the gas has been well below the threshold (used to re-arm after Reset)
`,
`        "gas_ok_since": None, # since when the gas has been well below the threshold (used to re-arm after Reset)
        "warn_ack": False}    # after Reset: no amber "gas is rising" theme until the gas has really dropped once
`);

// 2) sensor loop: gas warning is off after Reset until the gas is <= 70 % of the threshold
once('app.py',
`                gas_warn = armed and gas is not None and warm == 0 and gas > thr * 0.7
`,
`                if gas is not None and gas <= thr * 0.7:
                    ctrl["warn_ack"] = False        # gas is really low again: warnings work normally again
                gas_warn = armed and gas is not None and warm == 0 and gas > thr * 0.7 and not ctrl["warn_ack"]
`);

// 3) Reset alarm: acknowledge the warning too, and answer "safe" right away
once('app.py',
`            ctrl["muted"] = False
            # answer right away: do not wait for the next sensor loop (up to SAMPLE_INTERVAL) to clear the state
`,
`            ctrl["muted"] = False
            ctrl["warn_ack"] = True         # back to the normal colour now, even if the gas is still elevated
            # answer right away: do not wait for the next sensor loop (up to SAMPLE_INTERVAL) to clear the state
`);
once('app.py',
`                state["status"] = "warning" if (g_now is not None and g_now > thr_now * 0.7) else "safe"
`,
`                state["status"] = "safe"
`);

/* ================================================================ index.html */
// keep the "gas is still high" message, but with the normal colour
once('templates/index.html',
`  } else if (d.status === 'warning' && d.gas !== null && d.gas > d.threshold) {`,
`  } else if ((d.status === 'warning' || d.status === 'safe') && d.gas !== null && d.gas > d.threshold) {`);

/* ================================================================ alarm.js */
// colour follows every poll answer (instant after Reset, and on the History page too)
once('static/alarm.js',
`    if (d && my === gen && !resetting) { try { update(d); }`,
`    if (d && my === gen && !resetting) { if (d.status) document.body.dataset.s = d.status; try { update(d); }`);

/* ================================================================ cache-bust */
for (const f of ['templates/index.html', 'templates/history.html', 'templates/settings.html']) {
  once(f, '/static/alarm.js?v=9"', '/static/alarm.js?v=10"');
}

/* ================================================================ write */
for (const [rel, e] of out) {
  if (e.text === e.raw.replace(/\r\n/g, '\n')) continue;
  console.log((DRY ? '[dry-run] would patch ' : 'patching ') + rel);
  if (DRY) continue;
  const bak = path.join(ROOT, '.patch12-backup', rel);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, e.raw);
  fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Stop the old app.py, then start it again:  python app.py   (and Ctrl+F5 in the browser)');
