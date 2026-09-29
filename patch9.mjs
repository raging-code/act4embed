#!/usr/bin/env node
/**
 * patch9.mjs - act4embed, ninth round: premium "Frosted Glass" alarm pop-up + instant "Reset alarm".
 * Apply on top of the repo after patch8 (commit "Pop up msg", 7e6d1f1).
 *
 *   1) Design: replaces the classic white/red card with the Design 1 "Frosted Glass" pop-up
 *      (blurred dark overlay, translucent card, pulsing bell, rounded reading rows, white pill button).
 *   2) Speed: "Reset alarm" used to feel slow because
 *        - the button only set flags; the alarm state was recomputed by the sensor loop up to 0.5 s later,
 *        - then the pop-up waited for the next 1 s poll, and the button stayed disabled meanwhile.
 *      Now
 *        - static/alarm.js closes the pop-up the moment you tap (poll answers that were already on their
 *          way are ignored until the server confirms), then sends the reset and re-checks at once,
 *        - app.py (reset_alarm) clears the alarm state and stops the buzzer immediately.
 *
 *   Everything from patch8 is kept: the pop-up opens exactly when the screen is red (status 'danger'),
 *   the fallback for an older app.py (no gas_alarm / vib_alarm), the "Alarm active" / reasons card and
 *   the console error logging.
 *
 *   Files changed: static/alarm.js, static/style.css, app.py, templates/{index,history,settings}.html
 *   (the templates only get ?v=8 -> ?v=9 so browsers load the new files).
 *
 * Usage (from the repo root, next to app.py):
 *     node patch9.mjs --dry-run   check only, writes nothing
 *     node patch9.mjs
 * If an anchor doesn't match, NOTHING is written. Backups go to .patch9-backup/
 * Undo with:  git checkout -- app.py static templates
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

// replace everything from `marker` to the end of the file
function fromMarker(rel, marker, repl) {
  const e = load(rel);
  const i = e.text.indexOf(marker);
  if (i < 0) fail(rel + ': anchor not found:\n  ' + marker);
  if (e.text.indexOf(marker, i + 1) >= 0) fail(rel + ': anchor is not unique:\n  ' + marker);
  e.text = e.text.slice(0, i) + repl;
}

const cur = load('static/alarm.js').text;
if (cur.includes('Design 1: frosted glass')) { console.log('Already patched (patch9). Nothing to do.'); process.exit(0); }
if (!cur.includes('legacy')) fail('static/alarm.js is not the patch8 version. Pull the latest repo (or run patch8.mjs) first.');

/* ============================================================ static/alarm.js */
const ALARM_JS = String.raw`/* Alarm pop-up (Design 1: frosted glass). Loaded on EVERY page, polls /data by itself.
   Gas stays on until "Reset alarm"; vibration clears 1 min after the last vibration.
   Reset closes the pop-up instantly; poll answers that were already on their way are ignored
   until the server has confirmed the reset. */
(function () {
  const ICON = '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/><path d="M21 6.727a11.05 11.05 0 0 0 -2.794 -3.727"/><path d="M3 6.727a11.05 11.05 0 0 1 2.792 -3.727"/>';
  const TITLE = { gas: 'Gas detected', vib: 'Vibration detected', both: 'Gas and vibration detected', any: 'Alarm active' };
  const box = document.createElement('div');
  box.className = 'alarm'; box.id = 'alarm'; box.hidden = true;
  box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'aTitle');
  box.innerHTML =
    '<div class="acard">' +
      '<div class="ahead"><span class="aico"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON + '</svg></span><span class="alab">Alarm</span></div>' +
      '<h2 id="aTitle"></h2>' +
      '<div class="arows" id="aRows"></div>' +
      '<button class="areset" id="aReset" type="button">Reset alarm</button>' +
    '</div>';
  document.body.appendChild(box);
  const rows = document.getElementById('aRows'), btn = document.getElementById('aReset'), title = document.getElementById('aTitle');
  const fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  function row(label, value, sub) {
    const r = document.createElement('div'); r.className = 'arow';
    const l = document.createElement('span'); l.className = 'al'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'av';
    const b = document.createElement('b'); b.textContent = value;
    const s = document.createElement('span'); s.className = 'as'; s.textContent = sub ? ' \u00b7 ' + sub : '';
    v.append(b, s); r.append(l, v); return r;
  }

  function hide() {
    if (box.hidden) return;
    box.hidden = true; document.body.classList.remove('alarming');
    document.querySelectorAll('header,main').forEach(e => { e.inert = false; });
  }

  let warned = false, busy = false, resetting = false, gen = 0;

  function update(d) {
    // An older app.py sends no gas_alarm / vib_alarm: work them out from the readings instead.
    const legacy = d.gas_alarm === undefined && d.vib_alarm === undefined;
    if (legacy && !warned) { warned = true; console.warn('[alarm] /data has no gas_alarm / vib_alarm. Restart python app.py so the latest app.py is running.'); }
    const g = legacy ? (d.gas !== null && d.gas !== undefined && Number(d.gas) > Number(d.threshold)) : !!d.gas_alarm;
    const v = legacy ? !!d.vibration : !!d.vib_alarm;
    const on = d.status === 'danger';   // the pop-up opens exactly when the screen turns red
    if (!on) { hide(); return; }
    title.textContent = TITLE[g && v ? 'both' : g ? 'gas' : v ? 'vib' : 'any'];
    const items = [];
    if (g) items.push(row('Gas level', d.gas === null ? '--' : Number(d.gas), 'Limit ' + Number(d.threshold)));
    if (v) items.push(row('Vibration', d.vibration ? 'Active' : 'Stopped', 'Off in ' + fmt(Number(d.vib_left) || 0)));
    if (!items.length) items.push(row('Reason', (Array.isArray(d.reasons) && d.reasons.join('; ')) || 'An alarm is active', ''));
    rows.replaceChildren(...items);
    if (box.hidden) {
      box.hidden = false; document.body.classList.add('alarming');
      document.querySelectorAll('header,main').forEach(e => { e.inert = true; });
      btn.focus();
    }
  }

  async function poll(force) {
    if (!force && (busy || resetting)) return;
    const my = gen; let d = null; busy = true;
    try {
      const r = await fetch('/data?since=1e18', { cache: 'no-store' });
      if (r.ok) d = await r.json();
    } catch (e) { /* server unreachable: keep the current pop-up state */ }
    finally { busy = false; }
    // ignore answers that were requested before the reset button was pressed
    if (d && my === gen && !resetting) { try { update(d); } catch (e) { console.error('[alarm] pop-up error:', e); } }
  }

  btn.onclick = async () => {
    if (resetting) return;
    resetting = true; gen++;      // ignore every poll answer that was already on its way
    hide();                       // close right now, do not wait for the server
    try { await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset_alarm' }) }); } catch (e) {}
    resetting = false;
    poll(true);                   // confirm at once (re-opens only if the server still reports an alarm)
  };
  poll(); setInterval(poll, 1000);
})();
`;
load('static/alarm.js').text = ALARM_JS;

/* ============================================================ static/style.css */
const ALARM_CSS = String.raw`/* ambient-alarm: pop-up alert, Design 1 (frosted glass). Gas stays on until reset, vibration clears 1 min after it stops. */
body.alarming{overflow:hidden}
@keyframes apop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes afade{from{opacity:0}to{opacity:1}}
@keyframes aring{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.9);opacity:0}}
.alarm{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;overflow:auto;background:radial-gradient(circle at 50% 30%,rgba(179,18,27,.35),rgba(6,8,12,.82) 70%);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);animation:afade .15s ease-out}
.acard{width:100%;max-width:380px;padding:30px 26px 26px;border-radius:28px;background:linear-gradient(160deg,rgba(255,255,255,.14),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.2);box-shadow:0 30px 80px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.25);color:#fff;text-align:center;animation:apop .2s ease-out}
.ahead{display:flex;flex-direction:column;align-items:center;gap:14px;margin-bottom:6px}
.aico{position:relative;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:rgba(255,90,95,.18);color:#ff8589}
.aico::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid #ff5a5f;animation:aring 1.8s ease-out infinite}
.alab{font:600 .72rem Figtree,system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#ffb0b3}
.acard h2{font:700 1.6rem/1.15 "Bricolage Grotesque",Figtree,system-ui,sans-serif;letter-spacing:-.02em;margin:4px 0 18px;color:#fff;opacity:1}
.arows{display:grid;gap:8px;text-align:left}
.arow{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:13px 16px;border-radius:16px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1)}
.arow .al{color:rgba(255,255,255,.7);font-size:.9rem}
.arow .av{text-align:right;font-variant-numeric:tabular-nums}
.arow .av b{font-weight:700;font-size:1.15rem}
.arow .as{color:rgba(255,255,255,.55);font-size:.82rem}
.areset{width:100%;margin-top:20px;border:0;border-radius:99px;padding:14px;background:#fff;color:#14161a;font:700 1rem Figtree,system-ui,sans-serif;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .08s,box-shadow .15s}
.areset:hover{box-shadow:0 8px 24px rgba(255,255,255,.25)}
.areset:active{transform:scale(.97)}
.areset:focus-visible{outline:3px solid #ff8589;outline-offset:3px}
@media(prefers-reduced-motion:reduce){.alarm,.acard,.aico::after{animation:none}}
`;
fromMarker('static/style.css', '/* ambient-alarm: pop-up alert, Design 1 (classic card)', ALARM_CSS);

/* ============================================================ app.py */
// "Reset alarm" answers immediately: clear the alarm state and stop the buzzer now, not on the next sensor loop
once('app.py',
  `            ctrl["muted"] = False\n    elif action == "threshold":\n`,
  `            ctrl["muted"] = False\n`
  + `            # answer right away: do not wait for the next sensor loop (up to SAMPLE_INTERVAL) to clear the state\n`
  + `            state.update(gas_alarm=False, vib_alarm=False, vib_left=0, reasons=[])\n`
  + `            if state.get("status") == "danger":\n`
  + `                g_now, thr_now = state.get("gas"), settings["threshold"]\n`
  + `                state["status"] = "warning" if (g_now is not None and g_now > thr_now * 0.7) else "safe"\n`
  + `            fast_buzzer_off = ctrl["buzzer"] == "auto"\n`
  + `            if fast_buzzer_off:\n`
  + `                state["buzzer_on"] = False\n`
  + `        if fast_buzzer_off:\n`
  + `            try:\n`
  + `                hw.set_output("buzzer", False)\n`
  + `            except Exception:\n`
  + `                pass                        # the sensor loop reports output errors\n`
  + `    elif action == "threshold":\n`);

/* ============================================================ templates (cache-busting) */
for (const t of ['index', 'history', 'settings']) {
  const rel = 'templates/' + t + '.html';
  once(rel, '/static/style.css?v=8', '/static/style.css?v=9');
  once(rel, '/static/alarm.js?v=8', '/static/alarm.js?v=9');
}

/* ---- backups + write everything (or just report) */
const BAK = path.join(ROOT, '.patch9-backup');
for (const [rel, e] of out) {
  console.log((DRY ? 'would update ' : 'updating ') + rel);
  if (DRY) continue;
  fs.mkdirSync(path.dirname(path.join(BAK, rel)), { recursive: true });
  fs.writeFileSync(path.join(BAK, rel), e.raw);
  fs.writeFileSync(path.join(ROOT, rel), e.crlf ? e.text.replace(/\n/g, '\r\n') : e.text);
}
console.log(DRY ? '\nDry run OK. Run again without --dry-run to apply.'
                : '\nDone. Backups are in .patch9-backup/ (delete the folder when happy).\nRestart python app.py, hard-refresh the browser (Ctrl+F5), then press "Simulate gas leak" in Settings.');
