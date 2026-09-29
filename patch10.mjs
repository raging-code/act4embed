#!/usr/bin/env node
/**
 * patch10.mjs - act4embed, tenth round: make the alarm behave exactly like the spec.
 * Apply on top of the repo after patch9 (commit "Pop up alert msg", 2aae221).
 *
 * THE SPEC
 *   GAS / SMOKE   over the threshold -> alarm + pop-up, stays on until "Reset alarm";
 *                 Reset shuts the alarm down IMMEDIATELY.
 *   VIBRATION     vibration -> alarm + pop-up, stays on until "Reset alarm"
 *                 or until 1 minute after the alarm STARTED (whichever comes first).
 *
 * WHAT WAS WRONG (app.py)
 *   1) Vibration timer ran from the LAST vibration. Every new pulse pushed the 1 minute back, so a
 *      shaking table (or a chattering SW-420) kept the alarm on for ever. Now the 60 s run from the
 *      moment the alarm starts and vibration during the alarm does not extend it.
 *   2) Vibration alarm came straight back after "Reset alarm". The check was
 *      "last_vib > vib_ack", and while the sensor still reads active (or you just shook it by
 *      pressing the button) last_vib is refreshed on every loop, so the alarm re-armed itself at once.
 *      Now a reset ignores vibration for VIB_RESET_GRACE seconds (default 3), and when the 1 minute
 *      runs out only NEW vibration can start the next alarm.
 *   3) Reset could be undone by the sensor loop. The loop decided the alarm in one lock block and wrote
 *      the buzzer + state in later ones. A reset that landed in between was overwritten: the buzzer
 *      went back on and the pop-up re-opened for up to 0.5 s, and a stale alert could be logged.
 *      Now every reset bumps a counter (reset_gen); the loop notices it and redoes the pass, and the
 *      buzzer is only driven while holding the lock.
 *   4) Re-arming (Arm button) could fire an alarm for vibration that happened while disarmed.
 *      Vibration is now discarded while disarmed.
 *
 *   Gas logic itself was already right (latched until reset). Two things you may still notice, both by design:
 *     - gas alarms are ignored during the MQ-2 warm-up (WARMUP_SECONDS, 120 s after the ESP32 powers on);
 *     - after Reset while the gas is STILL above the threshold, it stays quiet until the level has dropped
 *       below the threshold once (otherwise it would instantly re-alarm and Reset would seem broken).
 *
 *   Files changed: app.py, config.py (new VIB_RESET_GRACE, comment), static/alarm.js (comment only).
 *
 * Usage (from the repo root, next to app.py):
 *     node patch10.mjs --dry-run   check only, writes nothing
 *     node patch10.mjs
 * If an anchor doesn't match, NOTHING is written. Backups go to .patch10-backup/
 * Undo with:  git checkout -- app.py config.py static
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
if (app0.includes('reset_gen')) { console.log('Already patched (patch10). Nothing to do.'); process.exit(0); }
if (!app0.includes('"vib_ack"')) fail('app.py is not the patch9 version. Pull the latest repo (or run patch9.mjs) first.');

/* ================================================================ app.py */

// 1) new control fields
once('app.py',
`        "vib_ack": 0.0}       # time of the last "Reset alarm": vibration before it no longer counts
`,
`        "vib_ack": 0.0,       # vibration up to this moment is ignored (Reset alarm, timeout, or while disarmed)
        "vib_start": 0.0,     # when the running vibration alarm started (0 = no vibration alarm)
        "reset_gen": 0}       # +1 on every "Reset alarm": lets the sensor loop see a reset that happened mid-pass
`);

// 2) remember the reset counter this pass is based on
once('app.py',
`                thr = settings["threshold"]
                warm = 0 if (SIMULATION and ctrl.get("sim_skip_warmup")) else warmup_left(now)
`,
`                my_gen = ctrl["reset_gen"]
                thr = settings["threshold"]
                warm = 0 if (SIMULATION and ctrl.get("sim_skip_warmup")) else warmup_left(now)
`);

// 3) vibration alarm: 60 s from the START of the alarm, or until Reset
once('app.py',
`                vib_age = now - last_vib
                # vibration: on for VIB_ALARM_HOLD seconds after the last pulse; disarmed: measured, never alarms
                vib_alarm = bool(armed and last_vib > ctrl["vib_ack"] and vib_age < config.VIB_ALARM_HOLD)
                vib_left = int(math.ceil(config.VIB_ALARM_HOLD - vib_age)) if vib_alarm else 0
`,
`                # vibration: the alarm starts on the first vibration and ends on "Reset alarm" or
                # VIB_ALARM_HOLD seconds after it STARTED (more vibration does not extend it).
                # Disarmed: measured, never alarms, and old vibration is thrown away.
                hold = config.VIB_ALARM_HOLD
                if not armed:
                    ctrl["vib_start"] = 0.0
                    ctrl["vib_ack"] = now
                if ctrl["vib_start"] and now - ctrl["vib_start"] >= hold:
                    ctrl["vib_start"] = 0.0         # 1 minute is up
                    ctrl["vib_ack"] = now           # only NEW vibration may start the next alarm
                if armed and not ctrl["vib_start"] and last_vib > ctrl["vib_ack"]:
                    ctrl["vib_start"] = now
                vib_alarm = bool(armed and ctrl["vib_start"])
                vib_left = max(0, int(math.ceil(hold - (now - ctrl["vib_start"])))) if vib_alarm else 0
`);

// 4) drive the buzzer / LED only while holding the lock, and not at all if Reset came in meanwhile
once('app.py',
`            for name, on in (("buzzer", buzzer_on), ("led", led_on)):
                try:
                    hw.set_output(name, on)
                except Exception as e:
                    errors.append(f"{name.upper()} error: {e}")
`,
`            with lock:
                stale = ctrl["reset_gen"] != my_gen
                if not stale:
                    for name, on in (("buzzer", buzzer_on), ("led", led_on)):
                        try:
                            hw.set_output(name, on)
                        except Exception as e:
                            errors.append(f"{name.upper()} error: {e}")
            if stale:
                continue                            # "Reset alarm" was pressed during this pass: redo it now
`);

// 5) do not overwrite the state a reset has just cleared
once('app.py',
`            with lock:
                state.update(
                    gas=gas,
`,
`            with lock:
                if ctrl["reset_gen"] != my_gen:
                    continue                        # reset landed after the outputs: redo the pass
                state.update(
                    gas=gas,
`);

// 6) Reset alarm: stop the vibration alarm now, ignore the shake of pressing the button
once('app.py',
`            ctrl["vib_ack"] = time.time()   # vibration before this moment no longer counts
`,
`            ctrl["reset_gen"] += 1
            ctrl["vib_start"] = 0.0         # vibration alarm off right now
            # vibration up to now, plus a short grace for the shake of pressing the button, no longer counts
            ctrl["vib_ack"] = time.time() + getattr(config, "VIB_RESET_GRACE", 3)
`);

// 7) test button must work right after a reset too
once('app.py',
`    elif action == "sim_vibration" and SIMULATION:
        hw.vib_event = time.time()
`,
`    elif action == "sim_vibration" and SIMULATION:
        with lock:
            ctrl["vib_ack"] = min(ctrl["vib_ack"], time.time() - 0.01)   # test button: skip the post-reset grace
        hw.vib_event = time.time()
`);

/* ================================================================ config.py */
once('config.py',
`VIB_ALARM_HOLD = 60           # a vibration alarm turns off this many seconds after the LAST vibration (or on Reset alarm)
`,
`VIB_ALARM_HOLD = 60           # a vibration alarm turns off this many seconds after it STARTED (or on Reset alarm)
VIB_RESET_GRACE = 3           # after Reset alarm, vibration is ignored this long (the button press itself shakes the sensor)
`);

/* ================================================================ static/alarm.js (comment only) */
once('static/alarm.js',
`   Gas stays on until "Reset alarm"; vibration clears 1 min after the last vibration.`,
`   Gas stays on until "Reset alarm"; vibration clears on Reset or 1 min after the alarm started.`);

/* ================================================================ write */
for (const [rel, e] of out) {
  if (e.text === e.raw.replace(/\r\n/g, '\n')) continue;
  console.log((DRY ? '[dry-run] would patch ' : 'patching ') + rel);
  if (DRY) continue;
  const bak = path.join(ROOT, '.patch10-backup', rel);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, e.raw);
  fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Restart the app:  pkill -f app.py ; python app.py');
