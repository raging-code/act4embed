#!/usr/bin/env node
/**
 * patch5.mjs - act4embed, fifth round: alarm pop-up + new alarm rules.
 * Apply on top of the current repo (the "Improved graph designs" commit, i.e. patch4 already applied).
 *
 *   New alarm rules (app.py, config.py)
 *     - GAS is latched: once gas goes above the threshold the alarm stays on, even if the level
 *       drops again, until someone presses "Reset alarm".
 *     - VIBRATION turns off by itself 1 minute after the last vibration (config.VIB_ALARM_HOLD = 60),
 *       or immediately when "Reset alarm" is pressed. New vibration after a reset alarms again.
 *     - After a gas reset the alarm stays off until the level has dropped to the threshold (or below)
 *       once and then rises above it again. While it is still high the page shows "Gas is still high".
 *     - Both at once: one pop-up that says "Gas and vibration detected".
 *     - New POST /control action: "reset_alarm". /data gets gas_alarm, vib_alarm and vib_left (seconds).
 *     - The alert log and e-mails work as before (a Gas alarm, then a "Gas + Vibration" row when
 *       vibration joins).
 *
 *   Pop-up (templates/index.html, static/style.css) - "glass card" design
 *     - frosted glass card centred over the blurred red screen, nothing else on it:
 *       icon, title, the key values (gas level + limit, vibration state + time until off), Reset alarm
 *     - page behind is inert while it is open (keyboard focus goes to the Reset button)
 *
 * Usage (from the repo root, next to app.py):
 *     node patch5.mjs --dry-run   check only, writes nothing
 *     node patch5.mjs
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

if (load('static/style.css').text.includes('ambient-alarm')) { console.log('Already patched (patch5). Nothing to do.'); process.exit(0); }

/* ================================================================== config.py */
once('config.py',
  `VIB_HOLD_SECONDS = 3`,
  `VIB_ALARM_HOLD = 60           # a vibration alarm turns off this many seconds after the LAST vibration (or on Reset alarm)\n`
  + `VIB_HOLD_SECONDS = 3`);

/* ==================================================================== app.py */
// shared flags between the sensor loop and the /control endpoint
once('app.py',
  `ctrl = {"buzzer": "auto", "led": "auto", "muted": False}`,
  `ctrl = {"buzzer": "auto", "led": "auto", "muted": False,\n`
  + `        "gas_latch": False,   # gas alarm is latched until "Reset alarm"\n`
  + `        "gas_ack": False,     # alarm was reset while gas was high: wait until the level has dropped once\n`
  + `        "vib_ack": 0.0}       # time of the last "Reset alarm": vibration before it no longer counts`);

// the new alarm rules
once('app.py',
  `                gas_alarm = armed and gas is not None and warm == 0 and gas > thr\n`
  + `                gas_warn = armed and gas is not None and warm == 0 and gas > thr * 0.7\n`
  + `                vib_alarm = armed and vibration     # disarmed: still measured, never alarms\n`,
  `                gas_hit = armed and gas is not None and warm == 0 and gas > thr\n`
  + `                if not armed:\n`
  + `                    ctrl["gas_latch"] = ctrl["gas_ack"] = False\n`
  + `                if gas is not None and gas <= thr:\n`
  + `                    ctrl["gas_ack"] = False         # level is normal again: the next rise alarms again\n`
  + `                if gas_hit and not ctrl["gas_ack"]:\n`
  + `                    ctrl["gas_latch"] = True        # latched: stays on until "Reset alarm" is pressed\n`
  + `                gas_alarm = bool(armed and ctrl["gas_latch"])\n`
  + `                gas_warn = armed and gas is not None and warm == 0 and gas > thr * 0.7\n`
  + `                vib_age = now - last_vib\n`
  + `                # vibration: on for VIB_ALARM_HOLD seconds after the last pulse; disarmed: measured, never alarms\n`
  + `                vib_alarm = bool(armed and last_vib > ctrl["vib_ack"] and vib_age < config.VIB_ALARM_HOLD)\n`
  + `                vib_left = int(math.ceil(config.VIB_ALARM_HOLD - vib_age)) if vib_alarm else 0\n`);

once('app.py',
  `                if gas_alarm:\n`
  + `                    reasons.append(f"Gas level {gas} is above the threshold {thr}")\n`,
  `                if gas_alarm:\n`
  + `                    reasons.append(f"Gas level {gas} is above the threshold {thr}"\n`
  + `                                   if gas is not None and gas > thr else "Gas alarm stays on until it is reset")\n`);

// send the new values to the page
once('app.py',
  `                    last_vib=round(last_vib, 1) if last_vib else None)`,
  `                    last_vib=round(last_vib, 1) if last_vib else None,\n`
  + `                    gas_alarm=gas_alarm, vib_alarm=vib_alarm, vib_left=vib_left)`);

// the Reset alarm button
once('app.py',
  `    elif action == "threshold":\n`,
  `    elif action == "reset_alarm":\n`
  + `        with lock:\n`
  + `            ctrl["gas_latch"] = False\n`
  + `            ctrl["gas_ack"] = True          # ignore gas until the level has dropped to the threshold once\n`
  + `            ctrl["vib_ack"] = time.time()   # vibration before this moment no longer counts\n`
  + `            ctrl["muted"] = False\n`
  + `    elif action == "threshold":\n`);

/* ============================================================== style.css */
{
  const e = load('static/style.css');
  e.text = e.text.replace(/\s*$/, '\n') + String.raw`
/* ambient-alarm: pop-up alert (glass card). Gas stays on until reset, vibration clears 1 min after it stops. */
body.alarming{overflow:hidden}
.alarm{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;overflow:auto;background:rgba(70,4,9,.72)}
@supports((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.alarm{background:rgba(70,4,9,.38);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}}
.acard{width:100%;max-width:380px;text-align:center;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);border-radius:28px;padding:30px 28px 28px}
.acard .aic{display:block;margin:0 auto}
.acard h2{font:800 1.75rem/1.05 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.03em;opacity:1;margin:14px 0 0;text-wrap:balance}
.avals{display:grid;margin:24px 0 26px;padding:16px 0;border-top:1px solid rgba(255,255,255,.25);border-bottom:1px solid rgba(255,255,255,.25)}
.avals.c2{grid-template-columns:1fr 1fr}
.avals>div{display:grid;gap:2px;padding:0 8px}
.avals.c2>div+div{border-left:1px solid rgba(255,255,255,.25)}
.avals .al,.avals .as{font-size:.78rem;opacity:.85}
.avals b{font:800 1.9rem/1.1 "Bricolage Grotesque",system-ui,sans-serif;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.areset{width:100%;border:0;border-radius:99px;padding:14px;background:#fff;color:#b3121b;font:800 1rem Figtree,system-ui,sans-serif;cursor:pointer;transition:transform .15s}
.areset:hover:not(:disabled){transform:translateY(-1px)}
.areset:disabled{opacity:.6;cursor:default}
@media(prefers-reduced-motion:reduce){.areset{transition:none}}
`;
}

/* ========================================================= templates/index.html */
// the pop-up markup
once('templates/index.html',
  `</main>\n`,
  `</main>\n\n`
  + `<div class="alarm" id="alarm" role="alertdialog" aria-modal="true" aria-labelledby="aTitle" hidden>\n`
  + `  <div class="acard">\n`
  + `    <svg class="aic" id="aIcon" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>\n`
  + `    <h2 id="aTitle">Gas detected</h2>\n`
  + `    <div class="avals" id="aVals"></div>\n`
  + `    <button class="areset" id="aReset">Reset alarm</button>\n`
  + `  </div>\n`
  + `</div>\n`);

// headline on the page behind the pop-up: use the new flags (the 3 s "vibration" flag is too short now)
once('templates/index.html',
  `    const g = d.reasons.some(r => r.indexOf('Gas') === 0);\n`
  + `    t = g && d.vibration ? 'Gas and vibration' : g ? 'Gas alarm' : 'Vibration';\n`,
  `    const g = !!d.gas_alarm, v = !!d.vib_alarm;\n`
  + `    t = g && v ? 'Gas and vibration' : g ? 'Gas alarm' : 'Vibration';\n`);

// alarm was reset but the gas level is still above the limit
once('templates/index.html',
  `  } else if (d.status === 'warmup') {\n`,
  `  } else if (d.status === 'warning' && d.gas !== null && d.gas > d.threshold) {\n`
  + `    t = 'Gas is still high'; s = 'The alarm was reset, but the level is still above the threshold.';\n`
  + `  } else if (d.status === 'warmup') {\n`);

once('templates/index.html',
  `  $('muteBtn').hidden = !(d.buzzer_on && !d.muted);\n`,
  `  $('muteBtn').hidden = !(d.buzzer_on && !d.muted);\n`
  + `  alarmUI(d);\n`);

// pop-up logic + Reset button
once('templates/index.html',
  `$('muteBtn').onclick = () => control('mute');\n`,
  String.raw`/* ---------- alarm pop-up ---------- */
const AIC = {
  gas: '<path d="M12 12c2 -2.96 0 -7 -1 -8c0 3.038 -1.773 4.741 -3 6c-1.226 1.26 -2 3.24 -2 5a6 6 0 1 0 12 0c0 -1.532 -1.056 -3.94 -2 -5c-1.786 3 -2.791 3 -4 2z"/>',
  vib: '<path d="M3 12h4l3 8l4 -16l3 8h4"/>',
  both: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>'
};
const ATT = { gas: 'Gas detected', vib: 'Vibration detected', both: 'Gas and vibration detected' };
let aKey = '';
function alarmUI(d) {
  const g = !!d.gas_alarm, v = !!d.vib_alarm, on = d.status === 'danger' && (g || v), box = $('alarm');
  if (!on) {
    if (!box.hidden) {
      box.hidden = true; document.body.classList.remove('alarming');
      document.querySelectorAll('header,main').forEach(e => { e.inert = false; });
    }
    aKey = ''; return;
  }
  const cell = (l, val, sub) => '<div><span class="al">' + l + '</span><b>' + val + '</b><span class="as">' + sub + '</span></div>';
  $('aVals').innerHTML =
    (g ? cell('Gas level', d.gas === null ? '--' : Number(d.gas), 'Limit ' + Number(d.threshold)) : '')
    + (v ? cell('Vibration', d.vibration ? 'Active' : 'Stopped', 'Off in ' + fmt(Number(d.vib_left) || 0)) : '');
  $('aVals').className = 'avals' + (g && v ? ' c2' : '');
  const k = g && v ? 'both' : g ? 'gas' : 'vib';
  if (k !== aKey) { aKey = k; $('aIcon').innerHTML = AIC[k]; $('aTitle').textContent = ATT[k]; }
  if (box.hidden) {
    box.hidden = false; document.body.classList.add('alarming');
    document.querySelectorAll('header,main').forEach(e => { e.inert = true; });
    $('aReset').focus();
  }
}
$('aReset').onclick = async () => {
  const b = $('aReset'); b.disabled = true;
  await control('reset_alarm');
  setTimeout(() => { b.disabled = false; }, 1500);
};
$('muteBtn').onclick = () => control('mute');
`);

/* ================================================================== write */
for (const [rel, e] of out) {
  const text = e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text;
  if (DRY) console.log('[dry-run] would patch', rel);
  else { fs.writeFileSync(path.join(ROOT, rel), text); console.log('patched', rel); }
}
console.log(DRY ? '\nDry run OK: all anchors matched.' : '\nDone. Restart the app:  python app.py   (then hard-refresh the browser: Ctrl+Shift+R)');
