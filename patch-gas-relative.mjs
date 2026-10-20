#!/usr/bin/env node
/**
 * patch-gas-relative.mjs  -  act4embed: make the MQ-2 alarm react to alcohol / smoke
 *
 * Run from the project root:   node patch-gas-relative.mjs
 * Idempotent: running it again does nothing. All edits are validated first,
 * nothing is written unless every marker was found. CRLF files are handled.
 *
 * What it does
 *   config.py   ADC_DIVIDER_RATIO 1.5 -> 2.0     (your divider is 20k + 20k, the pin sees HALF of AO)
 *               DEFAULT_GAS_THRESHOLD 400 -> 150 (400 = 2.58 V at AO, your sensor peaks near 1.9 V)
 *               + GAS_RISE_COUNTS = 50           (alarm = clean-air baseline + 50 counts)
 *   app.py      + effective_threshold(): min(saved threshold, calibrated clean-air counts + GAS_RISE_COUNTS)
 *               sensor loop and "Reset alarm" use it, so the dashboard line, warning level and alarm all follow it
 *
 * After patching:  restart app.py, warm the MQ-2 up for a few minutes in clean air, press Calibrate.
 * Note: data/settings.json (saved from the Settings page) overrides DEFAULT_GAS_THRESHOLD.
 *       Without a calibration the saved threshold is used as before.
 */
import fs from "node:fs";
import path from "node:path";

console.log("patch-gas-relative v1 (CRLF-safe)");
const ROOT = process.cwd();
const MARK = "gas-relative-patch";
const P = (f) => path.join(ROOT, f);

const crlf = new Set();   // files that use CRLF on disk: matched as LF, written back as CRLF
function die(msg) { console.error("ERROR: " + msg); process.exit(1); }
const read = (f) => {
  if (!fs.existsSync(P(f))) die(`File not found: ${f}  (run this from the project root)`);
  const raw = fs.readFileSync(P(f), "utf8");
  if (raw.includes("\r\n")) { crlf.add(f); return raw.replace(/\r\n/g, "\n"); }
  return raw;
};
function swap(src, oldStr, newStr) {
  const i = src.indexOf(oldStr);
  if (i < 0) die(`text not found: ${oldStr.slice(0, 80)}`);
  if (src.indexOf(oldStr, i + 1) >= 0) die(`text not unique: ${oldStr.slice(0, 80)}`);
  return src.slice(0, i) + newStr + src.slice(i + oldStr.length);
}

const out = {};   // file -> new content (written at the very end)

// ======================================================================= config.py
{
  let s = read("config.py");
  if (s.includes(MARK)) { console.log("config.py: already patched"); }
  else {
    s = swap(s, "ADC_DIVIDER_RATIO = 1.5",
      "ADC_DIVIDER_RATIO = 2.0       # 20k + 20k divider: the ADS1115 pin sees HALF of AO  (" + MARK + ")");
    s = swap(s, "DEFAULT_GAS_THRESHOLD = 400",
      "DEFAULT_GAS_THRESHOLD = 150");
    // new setting goes right after the DEFAULT_GAS_THRESHOLD line
    const i = s.indexOf("DEFAULT_GAS_THRESHOLD = 150");
    const eol = s.indexOf("\n", i);
    s = s.slice(0, eol + 1) +
      "GAS_RISE_COUNTS = 50          # after Calibrate: alarm when gas is this many counts above the clean-air level\n" +
      "                              # (0 = off, use only the fixed threshold). Raise it if you get false alarms.  (" + MARK + ")\n" +
      s.slice(eol + 1);
    out["config.py"] = s;
  }
}

// ======================================================================= app.py
const EFFECTIVE_THR = String.raw`def effective_threshold():
    """Alarm level in 0-1023 counts (` + MARK + String.raw`).
    The saved threshold, but never higher than (calibrated clean-air level + GAS_RISE_COUNTS).
    An MQ-2 baseline differs per sensor, so a fixed number (e.g. 400) may never be reached by alcohol or smoke."""
    t = settings["threshold"]
    rise = getattr(config, "GAS_RISE_COUNTS", 0)
    clean = cal["clean_mv"]
    if rise and clean is not None:
        t = min(t, mv_to_counts(clean) + int(rise))
    return max(1, int(t))


`;
{
  let s = read("app.py");
  if (s.includes(MARK)) { console.log("app.py: already patched"); }
  else {
    // 1) helper, placed right before calibration_start()
    s = swap(s, "def calibration_start():", EFFECTIVE_THR + "def calibration_start():");
    // 2) sensor loop uses it
    s = swap(s,
      '                my_gen = ctrl["reset_gen"]\n                thr = settings["threshold"]\n',
      '                my_gen = ctrl["reset_gen"]\n                thr = effective_threshold()     # ' + MARK + '\n');
    // 3) "Reset alarm" must use the same level, or the re-arm logic disagrees with the alarm
    s = swap(s,
      'ctrl["gas_ack"] = g_prev is not None and g_prev > settings["threshold"] * getattr(config, "GAS_REARM_RATIO", 0.9)',
      'ctrl["gas_ack"] = g_prev is not None and g_prev > effective_threshold() * getattr(config, "GAS_REARM_RATIO", 0.9)');
    out["app.py"] = s;
  }
}

// ======================================================================= write
const files = Object.keys(out);
if (!files.length) { console.log("Nothing to do (already patched)."); process.exit(0); }
for (const f of files) fs.writeFileSync(P(f), crlf.has(f) ? out[f].replace(/\n/g, "\r\n") : out[f]);
console.log("Patched: " + files.join(", "));
console.log("Next: restart python app.py  ->  warm up in clean air  ->  press Calibrate on the Live page.");
