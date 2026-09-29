#!/usr/bin/env node
/**
 * patch7.mjs - act4embed, seventh round: "Simulate gas leak" now shows the pop-up.
 * Apply on top of the repo after patch6 (commit "Pop up alert").
 *
 *   Problem
 *     Gas alarms are ignored while the MQ-2 warms up (config.WARMUP_SECONDS = 120), but the
 *     "Simulate gas leak (10 s)" button only lasts 10 seconds. Pressed within 2 minutes of starting
 *     the app (or of the ESP32 powering up), the fake gas value goes above the threshold but is
 *     ignored, so no alarm and no pop-up. (Simulate vibration was never affected.)
 *
 *   Fix (app.py only)
 *     - In SIMULATION mode, pressing "Simulate gas leak" also skips the warm-up wait, so the
 *       alarm and the pop-up appear right away.
 *     - Real hardware is untouched: the flag is only ever set when SIMULATION is True.
 *
 * Usage (from the repo root, next to app.py):
 *     node patch7.mjs --dry-run   check only, writes nothing
 *     node patch7.mjs
 * If an anchor doesn't match, NOTHING is written. Undo with:  git checkout -- app.py
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

if (load('app.py').text.includes('sim_skip_warmup')) { console.log('Already patched (patch7). Nothing to do.'); process.exit(0); }

/* ==================================================================== app.py */
// 1) the alarm decision: no warm-up wait after the simulated-leak button was pressed (simulation only)
once('app.py',
  `                warm = warmup_left(now)\n`,
  `                warm = 0 if (SIMULATION and ctrl.get("sim_skip_warmup")) else warmup_left(now)\n`);

// 2) the test button sets the flag
once('app.py',
  `    elif action == "sim_gas" and SIMULATION:\n`
  + `        hw.sim_gas_until = time.time() + 10\n`,
  `    elif action == "sim_gas" and SIMULATION:\n`
  + `        hw.sim_gas_until = time.time() + 10\n`
  + `        with lock:\n`
  + `            ctrl["sim_skip_warmup"] = True     # test button: do not wait for the MQ-2 warm-up\n`);

/* ---- write everything (or just report) */
for (const [rel, e] of out) {
  console.log((DRY ? 'would update ' : 'updating ') + rel);
  if (!DRY) fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY ? '\nDry run OK. Run again without --dry-run to apply.' : '\nDone. Restart python app.py, then press "Simulate gas leak" in Settings.');
