// =====================================================================
// components/  Dashboard UI: controls, sensor dashboard, state list,
// statistics, log, calibration editor, demo runner.
// =====================================================================
import { STATES, JOINTS, fk, GEOM } from './core.js';
import { hardwareSVG } from './hardware.js';

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const clock = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const JNAME = { base: ['BASE', 'S1 · D3'], shoulder: ['SHOULDER', 'S2 · D5'], elbow: ['ELBOW', 'S3 · D6'], gripper: ['GRIPPER', 'S4 · D9'] };

async function copyText(text, okMsg, log) {
  try { await navigator.clipboard.writeText(text); log('ok', okMsg); }
  catch { log('warn', 'Clipboard blocked by the browser. Text printed to the log instead.'); log('data', text); }
}

// ------------------------------------------------------------ demo runner
export class DemoRunner {
  constructor(sim, ui) { this.sim = sim; this.ui = ui; this.q = null; }
  busy() { return this.sim.state !== 'IDLE' || this.sim.caps.some((c) => ['falling', 'spawning', 'held'].includes(c.state)); }
  prep() {
    const s = this.sim;
    if (s.state === 'ERROR') s.reset();
    if (this.busy()) { s.log('warn', 'Robot busy. Wait for the current cycle or press RESET.'); return false; }
    if (s.padCap()) s.removePadCap();
    s.awaitPadClear = false;
    s.start();
    return true;
  }
  single(kind) {
    this.q = null;
    if (!this.prep()) return;
    this.sim.log('info', `DEMO: loading ${kind} cap onto conveyor.`);
    this.sim.spawnCap(kind, null, true);
    this.ui.setDemo(`${kind} demo running…`);
    this.q = { items: [], cur: { kind, phase: 'run' }, t: 0, single: true };
  }
  full() {
    this.q = null;
    if (!this.prep()) return;
    this.sim.log('info', 'DEMO: complete conveyor sorting run (RED, GREEN, BLUE, UNKNOWN).');
    this.q = { items: ['RED', 'GREEN', 'BLUE', 'RANDOM'], cur: null, t: 0 };
  }
  stop(msg) { if (this.q) { this.q = null; this.ui.setDemo(msg); } }
  update(dt) {
    const q = this.q, s = this.sim;
    if (!q || s.paused) return;
    if (s.state === 'ERROR') { this.sim.log('error', 'Demo aborted because of ERROR.'); this.stop('Demo aborted (error).'); return; }
    if (s.mode !== 'AUTO' || !s.running) { this.stop('Demo stopped.'); return; }
    if (q.cur) {
      if (!this.busy() && !s.padCap() && !s.caps.some(c => c.state === 'conveyor')) {
        q.t += dt;
        if (q.t > 1.0) { q.cur = null; q.t = 0; }
      }
      return;
    }
    if (!q.items.length) {
      s.log('ok', q.single ? 'DEMO finished.' : 'DEMO: complete sorting sequence finished.');
      this.stop('Demo finished. ' + `Red ${s.stats.red} · Green ${s.stats.green} · Blue ${s.stats.blue} · Unknown ${s.stats.unknown}.`);
      return;
    }
    const k = q.items.shift();
    q.cur = { kind: k }; q.t = 0;
    this.ui.setDemo(`Conveyor sorting demo: loading ${k} cap…`);
    s.spawnCap(k, null, true);
  }
}

// --------------------------------------------------------------------- UI
export class Dashboard {
  constructor(sim, view) {
    this.sim = sim; this.view = view;
    this.visited = new Set();
    this.demo = new DemoRunner(sim, this);
    this.logLines = [];
    this.buildStatic();
    this.bind();
    sim.on((type, d) => this.onEvent(type, d));
    this.renderStates(); this.renderSensor(); this.renderStats(); this.renderMode();    this.lastRefresh = 0;
  }

  // ---------- events from the simulation
  onEvent(type, d) {
    if (type === 'log') this.addLog(d.level, d.msg, d.t);
    else if (type === 'state') {
      if (d.next === 'IDLE' || d.next === 'DETECTING_CAP') this.visited.clear();
      this.visited.add(d.prev); this.renderStates(); this.renderMode();
    } else if (type === 'reading') { this.lastReading = d; this.renderSensor(); }
    else if (type === 'stats') this.renderStats();
    else if (type === 'mode') this.renderMode();
    else if (type === 'cmd' && $('showCmd').checked) this.addLog('cmd', `CMD base=${d.base.toFixed(0)} shoulder=${d.shoulder.toFixed(0)} elbow=${d.elbow.toFixed(0)} gripper=${d.gripper.toFixed(0)}`, this.sim.time);
  }

  addLog(level, msg, t) {
    const el = $('log');
    const line = `[${clock()}] [t=${t.toFixed(2).padStart(6)}s] ${msg}`;
    this.logLines.push(line);
    const div = document.createElement('div');
    div.className = level === 'state' ? 'st' : level;
    div.innerHTML = `<span class="ts">[${clock()}] t=${t.toFixed(2).padStart(6)}s</span>  ${esc(msg)}`;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.appendChild(div);
    while (el.childNodes.length > 600) el.removeChild(el.firstChild);
    if (this.logLines.length > 2000) this.logLines.shift();
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
  setDemo(t) { $('demoStatus').textContent = t; }

  // ---------- static construction
  buildStatic() {
    const J = $('joints');
    J.innerHTML = JOINTS.map((k) => `
      <div class="joint"><div class="nm">${JNAME[k][0]}<small>${JNAME[k][1]}</small></div>
      <input type="range" id="j_${k}" step="1"><div class="v" id="jv_${k}">0°</div>
      <div class="t"><span id="jl_${k}"></span><span id="jt_${k}"></span></div></div>`).join('');
    const meter = (id, k, col) => `<div class="meter"><span class="k">${k}</span><div class="bar"><i id="${id}" style="background:${col}"></i><span id="${id}_m"></span></div><span class="n" id="${id}_v">0</span></div>`;
    $('rawM').innerHTML = meter('mR', 'R', '#ef4444') + meter('mG', 'G', '#22c55e') + meter('mB', 'B', '#3b82f6') + meter('mC', 'C', '#d1d5db');
    $('normM').innerHTML = meter('nR', 'nr', '#ef4444') + meter('nG', 'ng', '#22c55e') + meter('nB', 'nb', '#3b82f6');
    $('states').innerHTML = STATES.map((s, i) => `<li id="s_${s}" class="${s}"><span class="ix">${String(i + 1).padStart(2, '0')}</span>${s}</li>`).join('');
    $('hwSvg').innerHTML = hardwareSVG();
    if (window.lucide) try { window.lucide.createIcons(); } catch { /* icons optional */ }
  }

  bind() {
    const s = this.sim;
    $('bStart').onclick = () => { if (s.paused) s.setPaused(false); s.start(); };
    $('bPause').onclick = () => s.setPaused(!s.paused);
    $('bReset').onclick = () => { this.demo.stop('Demo stopped.'); s.reset(); };
    $('errReset').onclick = () => { this.demo.stop('Demo stopped.'); s.reset(); };
    $('bHome').onclick = () => s.home();
    $('mAuto').onclick = () => s.setMode('AUTO');
    $('mMan').onclick = () => { this.demo.stop('Demo stopped (manual mode).'); s.setMode('MANUAL'); };
    $('speed').oninput = (e) => { s.motion.speed = +e.target.value; $('speedV').textContent = (+e.target.value).toFixed(2) + '×'; };
    $('dRed').onclick = () => this.demo.single('RED');
    $('dGreen').onclick = () => this.demo.single('GREEN');
    $('dBlue').onclick = () => this.demo.single('BLUE');
    $('dAll').onclick = () => this.demo.full();
    $('dReset').onclick = () => { this.demo.stop('Scene reset.'); s.resetScene(); };
    $('dClear').onclick = () => s.clearTrays();
    document.querySelectorAll('[data-cap]').forEach((b) => (b.onclick = () => s.spawnCap(b.dataset.cap, null, true)));
    $('bCustom').onclick = () => s.spawnCap('CUSTOM', $('customCol').value, true);
    $('bRemove').onclick = () => s.removePadCap();
    $('bSeq').onclick = () => s.playSequence();
    $('bSeqStop').onclick = () => { s.stopSequence(); s.motion.halt(); };
    for (const k of JOINTS) $('j_' + k).oninput = (e) => s.manualJoint(k, +e.target.value);
    document.querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => {
      this.view.setView(b.dataset.cam);
      document.querySelectorAll('[data-cam]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('bMarker').onclick = (e) => { this.view.marker.visible = !this.view.marker.visible; e.currentTarget.classList.toggle('on', this.view.marker.visible); };
    $('logClear').onclick = () => { $('log').innerHTML = ''; this.logLines = []; };
    $('logCopy').onclick = () => copyText(this.logLines.join('\n'), 'Log copied to clipboard.', (l, m) => s.log(l, m));
    document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === t.dataset.view));
      if (t.dataset.view === 'simView') this.view.resize();
    }));
  }

  // ---------- renderers
  renderMode() {
    const s = this.sim, man = s.mode === 'MANUAL';
    $('mAuto').classList.toggle('on', !man); $('mMan').classList.toggle('on', man);
    $('bPause').innerHTML = s.paused ? '<i data-lucide="play"></i>RESUME' : '<i data-lucide="pause"></i>PAUSE';
    $('bStart').disabled = !man && s.running;
    $('jointMode').textContent = man ? 'MANUAL · LIVE' : 'AUTO · READ ONLY';
    for (const k of JOINTS) {
      const el = $('j_' + k), L = s.cfg.limits[k];
      el.disabled = !man; el.min = L.min; el.max = L.max;
      $('jl_' + k).textContent = `${L.min}°–${L.max}°`;
    }
    $('bSeq').disabled = !man; $('bSeqStop').disabled = !man;
    $('pausedTag').style.display = s.paused ? 'block' : 'none';
    const err = s.state === 'ERROR';
    $('errBox').classList.toggle('on', err); $('errMsg').textContent = s.error;
    const runTxt = man ? 'MANUAL' : (s.running ? 'AUTOMATIC · RUNNING' : 'AUTOMATIC · STOPPED (press START)');
    $('statePill').innerHTML = `${s.state}<small>${runTxt}${s.paused ? ' · PAUSED' : ''}</small>`;
    $('statePill').classList.toggle('err', err);
    const hp = $('hdrState'); hp.textContent = s.state; hp.className = 'pill' + (err ? ' err' : s.state === 'SORTING_COMPLETE' ? ' ok' : '');
    $('stState').textContent = s.state;
    if (window.lucide) try { window.lucide.createIcons(); } catch { /* optional */ }
  }

  renderStates() {
    const cur = this.sim.state;
    for (const st of STATES) {
      const li = $('s_' + st);
      li.classList.toggle('on', st === cur);
      li.classList.toggle('done', st !== cur && this.visited.has(st));
    }
  }

  renderSensor() {
    const s = this.sim, rd = s.reading, res = s.result, th = s.cfg.thresholds;
    const setM = (id, v, max, txt, mark) => {
      $(id).style.width = Math.min(100, (v / max) * 100) + '%';
      $(id + '_v').textContent = txt;
      $(id + '_m').innerHTML = mark !== undefined ? mark.map((m) => `<b style="left:${m * 100}%"></b>`).join('') : '';
    };
    setM('mR', rd.r, 1600, rd.r); setM('mG', rd.g, 1600, rd.g); setM('mB', rd.b, 1600, rd.b);
    setM('mC', rd.c, 2000, rd.c, [th.clearMin / 2000]);
    setM('nR', res.n.nr, 1, res.n.nr.toFixed(3), [th.redNrMin, th.greenNrMax, th.blueNrMax || 0.25]);
    setM('nG', res.n.ng, 1, res.n.ng.toFixed(3), [th.redNgMax, th.greenNgMin]);
    setM('nB', res.n.nb, 1, res.n.nb.toFixed(3), [th.greenNbMax, th.blueNbMin || 0.42]);
    const colors = { RED: '#dc2626', GREEN: '#16a34a', BLUE: '#2563eb', UNKNOWN: '#d97706', 'NO CAP': '#0d0e10' };
    const sum = rd.r + rd.g + rd.b || 1;
    $('detSw').style.background = res.label === 'NO CAP' ? colors['NO CAP'] : `rgb(${Math.round(255 * rd.r / sum * 1.6)},${Math.round(255 * rd.g / sum * 1.6)},${Math.round(255 * rd.b / sum * 1.6)})`;
    const L = $('detL'); L.textContent = res.label === 'NO CAP' ? 'NO CAP DETECTED' : res.label; L.style.color = res.label === 'NO CAP' ? '#6b7280' : colors[res.label];
    $('detS').textContent = this.lastReading && this.lastReading.averaged ? `averaged over ${s.cfg.sensor.samples} samples` : 'live reading';
    const st = $('sStat'); st.textContent = s.sensorStatus; st.className = 'sstat ' + s.sensorStatus;
    const c = res.checks, n = res.n;
    const r = (txt, ok) => `<tr><td>${txt}</td><td class="${ok ? 'pass' : 'fail'}">${ok ? '✓' : '✗'}</td></tr>`;
    $('rules').innerHTML =
      `<tr class="grpH"><td colspan="2">PRESENCE</td></tr>` + r(`C = ${rd.c} ≥ ${th.clearMin}`, c.clear) +
      `<tr class="grpH"><td colspan="2">RED → BIN 1</td></tr>` + r(`nr ${n.nr.toFixed(3)} &gt; ${th.redNrMin}`, c.redNr) + r(`ng ${n.ng.toFixed(3)} &lt; ${th.redNgMax}`, c.redNg) +
      `<tr class="grpH"><td colspan="2">GREEN → BIN 2</td></tr>` + r(`ng ${n.ng.toFixed(3)} &gt; ${th.greenNgMin}`, c.greenNg) + r(`nr ${n.nr.toFixed(3)} &lt; ${th.greenNrMax}`, c.greenNr) + r(`nb ${n.nb.toFixed(3)} &lt; ${th.greenNbMax}`, c.greenNb) +
      `<tr class="grpH"><td colspan="2">BLUE → BIN 3</td></tr>` + r(`nb ${n.nb.toFixed(3)} &gt; ${th.blueNbMin || 0.42}`, c.blueNb) + r(`nr ${n.nr.toFixed(3)} &lt; ${th.blueNrMax || 0.25}`, c.blueNr) +
      `<tr class="grpH"><td colspan="2">OTHERWISE → UNKNOWN (BIN 4)</td></tr>` +
      `<tr class="grpH"><td colspan="2">RESULT</td></tr><tr><td colspan="2" style="color:${res.label === 'NO CAP' ? '#9ca3af' : colors[res.label]};font-weight:600">${res.label}</td></tr>`;
  }

  renderStats() {
    const t = this.sim.stats;
    $('stTotal').textContent = t.total; $('stCycles').textContent = t.cycles;
    $('stRed').textContent = t.red;
    $('stGreen').textContent = t.green;
    $('stBlue').textContent = t.blue || 0;
    $('stUnk').textContent = t.unknown;
    $('stErr').textContent = t.errors;
  }

  // called every frame, throttled
  refresh(now) {
    if (now - this.lastRefresh < 60) return;
    this.lastRefresh = now;
    const s = this.sim, a = s.motion.angles(), tg = s.motion.targets();
    for (const k of JOINTS) {
      $('jv_' + k).textContent = a[k].toFixed(1) + '°';
      $('jt_' + k).textContent = `target ${tg[k].toFixed(0)}°`;
      const el = $('j_' + k);
      if (s.mode !== 'MANUAL' || document.activeElement !== el) el.value = s.mode === 'MANUAL' ? tg[k] : a[k];
    }
    const f = fk(a);
    const gapCm = (GEOM.GRIP.gapAtZero + a.gripper * GEOM.GRIP.gapPerDeg);
    $('fkOut').innerHTML = `<span>x</span><span>${f.grip.x.toFixed(2)} cm</span><span>y</span><span>${f.grip.y.toFixed(2)} cm${f.grip.y < 0.6 ? ' ⚠ below pad' : ''}</span><span>z</span><span>${f.grip.z.toFixed(2)} cm</span><span>reach</span><span>${f.reach.toFixed(2)} cm</span><span>finger gap</span><span>${Math.min(6, gapCm).toFixed(2)} cm${s.heldCap ? ' (holding cap)' : ''}</span>`;
    if (this._st !== s.state || this._sens !== s.sensorStatus) { this._st = s.state; this._sens = s.sensorStatus; this.renderMode(); this.renderSensor(); }
  }

}
