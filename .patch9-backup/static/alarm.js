/* Alarm pop-up (Design 1: classic card). Loaded on EVERY page, polls /data by itself.
   Gas stays on until "Reset alarm"; vibration clears 1 min after the last vibration. */
(function () {
  const ICON = '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/><path d="M21 6.727a11.05 11.05 0 0 0 -2.794 -3.727"/><path d="M3 6.727a11.05 11.05 0 0 1 2.792 -3.727"/>';
  const TITLE = { gas: 'Gas detected', vib: 'Vibration detected', both: 'Gas and vibration detected', any: 'Alarm active' };
  const box = document.createElement('div');
  box.className = 'alarm'; box.id = 'alarm'; box.hidden = true;
  box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'aTitle');
  box.innerHTML =
    '<div class="acard">' +
      '<div class="ahead"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON + '</svg><span>Alarm</span></div>' +
      '<div class="abody"><h2 id="aTitle"></h2><div id="aRows"></div><button class="areset" id="aReset" type="button">Reset alarm</button></div>' +
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

  let warned = false;

  function update(d) {
    // An older app.py sends no gas_alarm / vib_alarm: work them out from the readings instead.
    const legacy = d.gas_alarm === undefined && d.vib_alarm === undefined;
    if (legacy && !warned) { warned = true; console.warn('[alarm] /data has no gas_alarm / vib_alarm. Restart python app.py so the latest app.py is running.'); }
    const g = legacy ? (d.gas !== null && d.gas !== undefined && Number(d.gas) > Number(d.threshold)) : !!d.gas_alarm;
    const v = legacy ? !!d.vibration : !!d.vib_alarm;
    const on = d.status === 'danger';   // the pop-up opens exactly when the screen turns red
    if (!on) {
      if (!box.hidden) {
        box.hidden = true; document.body.classList.remove('alarming');
        document.querySelectorAll('header,main').forEach(e => { e.inert = false; });
      }
      return;
    }
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

  let busy = false;
  async function poll() {
    if (busy) return; busy = true;
    let d = null;
    try {
      const r = await fetch('/data?since=1e18', { cache: 'no-store' });
      if (r.ok) d = await r.json();
    } catch (e) { /* server unreachable: keep the current pop-up state */ }
    finally { busy = false; }
    if (d) { try { update(d); } catch (e) { console.error('[alarm] pop-up error:', e); } }
  }
  btn.onclick = async () => {
    btn.disabled = true;
    try { await fetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset_alarm' }) }); } catch (e) {}
    poll();
    setTimeout(() => { btn.disabled = false; }, 1500);
  };
  poll(); setInterval(poll, 1000);
})();
