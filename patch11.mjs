#!/usr/bin/env node
/**
 * patch11.mjs - act4embed, eleventh round: "Reset alarm" must really end the alarm (no re-pop).
 * Apply on top of the repo after patch10 (commit "pop up", 53990c4).
 *
 * THE SPEC
 *   GAS / SMOKE   over the threshold -> alarm + pop-up, stays on until "Reset alarm";
 *                 Reset shuts the alarm down IMMEDIATELY.
 *   VIBRATION     vibration -> alarm + pop-up, stays on until "Reset alarm"
 *                 or until 1 minute after the alarm STARTED (whichever comes first).
 *
 * WHY THE POP-UP CAME BACK AFTER "Reset alarm"   (all three reproduced by running the real sensor_loop)
 *   1) VIBRATION, sensor still active. patch10 ignored vibration for only 3 s after Reset. If the SW-420
 *      keeps reading "vibration" (pot too sensitive, table still shaking, VIB_ACTIVE_HIGH wrong), last_vib is
 *      refreshed on every loop, so 3 s later the alarm starts again and the pop-up re-opens.
 *   2) VIBRATION, 1 minute is up while it is still active. Same thing: the alarm ended at 60 s and
 *      restarted in the very next loop, so the pop-up seemed to "ignore" the 1-minute rule.
 *      -> Now after Reset AND after the 1-minute timeout the sensor must be QUIET for VIB_SETTLE_SECONDS
 *         (default 2 s) before it can start a new alarm. Vibration seen while waiting is thrown away.
 *   3) GAS hovering around the threshold. After Reset the gas alarm was muted until the level dropped to
 *      <= threshold ONCE. With a noisy MQ-2 (399, 402, 398, 403 ...) a single dip re-armed it and the next
 *      sample above the threshold latched the alarm again -> pop-up back within seconds.
 *      -> Now the gas must fall below GAS_REARM_RATIO x threshold (default 0.9) and STAY there for
 *         GAS_REARM_SECONDS (default 5 s) before it can alarm again. If the gas is already low when you
 *         press Reset (e.g. a vibration alarm) nothing is muted at all.
 *
 *   Unchanged on purpose: gas alarm is latched until Reset; Reset closes the pop-up and silences the buzzer at
 *   once; vibration alarm ends 60 s after it STARTED (later pulses do not extend it).
 *   Trade-off: continuous vibration / gas that never calms down is ignored after you have Reset it, which is
 *   what stops the pop-up from coming back. When it calms down, the system is armed again by itself.
 *
 *   Files changed: app.py, config.py (new VIB_SETTLE_SECONDS, GAS_REARM_RATIO, GAS_REARM_SECONDS).
 *
 * Usage (from the repo root, next to app.py):
 *     node patch11.mjs --dry-run   check only, writes nothing
 *     node patch11.mjs
 * If an anchor doesn't match, NOTHING is written. Backups go to .patch11-backup/
 * Undo with:  git checkout -- app.py config.py
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
if (app0.includes('"vib_wait"')) { console.log('Already patched (patch11). Nothing to do.'); process.exit(0); }
if (!app0.includes('reset_gen')) fail('app.py is not the patch10 version. Pull the latest repo (or run patch10.mjs) first.');

/* ================================================================ app.py */

// 1) new control fields
once('app.py',
`        "reset_gen": 0}       # +1 on every "Reset alarm": lets the sensor loop see a reset that happened mid-pass
`,
`        "reset_gen": 0,       # +1 on every "Reset alarm": lets the sensor loop see a reset that happened mid-pass
        "vib_wait": False,    # after Reset / 1-min timeout: vibration is ignored until the sensor has been quiet for a while
        "gas_ok_since": None} # since when the gas has been well below the threshold (used to re-arm after Reset)
`);

// 2) gas: after Reset, re-arm only when the level is clearly low AND stays low (hysteresis + settle time)
once('app.py',
`                if gas is not None and gas <= thr:
                    ctrl["gas_ack"] = False         # level is normal again: the next rise alarms again
`,
`                if gas is not None:
                    # re-arm after Reset only when the gas is clearly below the threshold and STAYS there
                    # (a noisy sensor hovering around the threshold must not bring the pop-up back)
                    if gas <= thr * getattr(config, "GAS_REARM_RATIO", 0.9):
                        if ctrl["gas_ok_since"] is None:
                            ctrl["gas_ok_since"] = now
                        if now - ctrl["gas_ok_since"] >= getattr(config, "GAS_REARM_SECONDS", 5):
                            ctrl["gas_ack"] = False     # level is normal again: the next rise alarms again
                    else:
                        ctrl["gas_ok_since"] = None
`);

// 3) vibration: after Reset or after the 1-minute timeout, wait until the sensor is quiet
once('app.py',
`                hold = config.VIB_ALARM_HOLD
                if not armed:
                    ctrl["vib_start"] = 0.0
                    ctrl["vib_ack"] = now
                if ctrl["vib_start"] and now - ctrl["vib_start"] >= hold:
                    ctrl["vib_start"] = 0.0         # 1 minute is up
                    ctrl["vib_ack"] = now           # only NEW vibration may start the next alarm
                if armed and not ctrl["vib_start"] and last_vib > ctrl["vib_ack"]:
                    ctrl["vib_start"] = now
`,
`                hold = config.VIB_ALARM_HOLD
                settle = getattr(config, "VIB_SETTLE_SECONDS", 2.0)
                if not armed:
                    ctrl["vib_start"] = 0.0
                    ctrl["vib_ack"] = now
                    ctrl["vib_wait"] = True
                if ctrl["vib_start"] and now - ctrl["vib_start"] >= hold:
                    ctrl["vib_start"] = 0.0         # 1 minute is up
                    ctrl["vib_ack"] = now
                    ctrl["vib_wait"] = True         # a sensor that is STILL vibrating must not restart the alarm at once
                if ctrl["vib_wait"]:
                    ctrl["vib_ack"] = max(ctrl["vib_ack"], last_vib)   # vibration seen while waiting is thrown away
                    if now - last_vib >= settle:
                        ctrl["vib_wait"] = False    # quiet long enough: only NEW vibration may alarm now
                if armed and not ctrl["vib_wait"] and not ctrl["vib_start"] and last_vib > ctrl["vib_ack"]:
                    ctrl["vib_start"] = now
`);

// 4) Reset alarm: gas is only muted if it is still high; vibration must calm down first
once('app.py',
`            ctrl["gas_latch"] = False
            ctrl["gas_ack"] = True          # ignore gas until the level has dropped to the threshold once
`,
`            ctrl["gas_latch"] = False
            g_prev = state.get("gas")
            # ignore gas until it has fallen clearly below the threshold (and stayed there); if it is already low, nothing to ignore
            ctrl["gas_ack"] = g_prev is not None and g_prev > settings["threshold"] * getattr(config, "GAS_REARM_RATIO", 0.9)
            ctrl["gas_ok_since"] = None
`);

once('app.py',
`            # vibration up to now, plus a short grace for the shake of pressing the button, no longer counts
            ctrl["vib_ack"] = time.time() + getattr(config, "VIB_RESET_GRACE", 3)
`,
`            # vibration up to now no longer counts, and new vibration only counts once the sensor has been quiet
            # for VIB_SETTLE_SECONDS (the button press itself shakes the sensor; a stuck sensor must not re-alarm)
            ctrl["vib_ack"] = time.time()
            ctrl["vib_wait"] = True
`);

// 5) test button must work right after a reset too
once('app.py',
`            ctrl["vib_ack"] = min(ctrl["vib_ack"], time.time() - 0.01)   # test button: skip the post-reset grace
`,
`            ctrl["vib_ack"] = min(ctrl["vib_ack"], time.time() - 0.01)   # test button: skip the post-reset grace
            ctrl["vib_wait"] = False                                      # test button: do not wait for a quiet sensor
`);

/* ================================================================ config.py */
once('config.py',
`VIB_RESET_GRACE = 3           # after Reset alarm, vibration is ignored this long (the button press itself shakes the sensor)
`,
`VIB_RESET_GRACE = 3           # (no longer used since patch11, see VIB_SETTLE_SECONDS)
VIB_SETTLE_SECONDS = 2        # after Reset alarm or the 1-minute timeout, the sensor must be quiet this long before it can alarm again
GAS_REARM_RATIO = 0.9         # after Reset alarm, gas must fall below this fraction of the threshold...
GAS_REARM_SECONDS = 5         # ...and stay there this many seconds before it can alarm again
`);

/* ================================================================ write */
for (const [rel, e] of out) {
  if (e.text === e.raw.replace(/\r\n/g, '\n')) continue;
  console.log((DRY ? '[dry-run] would patch ' : 'patching ') + rel);
  if (DRY) continue;
  const bak = path.join(ROOT, '.patch11-backup', rel);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, e.raw);
  fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Restart the app:  pkill -f app.py ; python app.py');
