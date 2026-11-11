// =====================================================================
// SIMULATION CORE  (no rendering, no DOM: runs headless in node tests)
//   data/       DEFAULT_CONFIG, GEOM
//   sensors/    TCS34725 model + classifier
//   robot/      forward kinematics, gripper mapping
//   controllers/MotionEngine (synchronised servo interpolation)
//   simulation/ caps, grip/release, landing zones
//   state-machine/ sorting state machine
// =====================================================================

// ---------------------------------------------------------------- data
export const GEOM = {
  H: 7.5,          // shoulder pivot height above bench (cm)
  L1: 9.0,         // upper arm length
  L2: 10.0,        // forearm length
  LG: 5.5,         // wrist pivot -> grip point (gripper kept vertical by passive linkage)
  PAD: { x: 0, z: 15, r: 2.0, h: 0.6 },
  CAP: { r: 1.5, h: 1.3 },
  TRAY: { dist: 15.5, inner: 6.8, wall: 2.4, floor: 0.3 },
  CONVEYOR: {
    startX: 0, startZ: 38,
    endX: 0, endZ: 14.5,
    width: 6.0, height: 0.6,
    speed: 7.0 // cm/s
  },
  GRIP: { gapAtZero: 0.2, gapPerDeg: 5.0 / 90 },   // finger gap (cm) vs gripper servo angle
  CAPTURE: { horiz: 0.8, vert: 0.7 },             // tolerance for a successful grip
};

export const BINS = {
  BIN_RED:     { id: 'BIN_RED',     label: 'Red',     color: '#dc2626', baseDeg: 155, key: 'red' },
  BIN_GREEN:   { id: 'BIN_GREEN',   label: 'Green',   color: '#16a34a', baseDeg: 120, key: 'green' },
  BIN_BLUE:    { id: 'BIN_BLUE',    label: 'Blue',    color: '#2563eb', baseDeg: 60,  key: 'blue' },
  BIN_UNKNOWN: { id: 'BIN_UNKNOWN', label: 'Unknown', color: '#d97706', baseDeg: 25,  key: 'unknown' },
};

export const JOINTS = ['base', 'shoulder', 'elbow', 'gripper'];

export const DEFAULT_CONFIG = {
  limits: {
    base:     { min: 10, max: 170, vmax: 60 },
    shoulder: { min: 35, max: 165, vmax: 50 },
    elbow:    { min: 25, max: 160, vmax: 50 },
    gripper:  { min: 10, max: 90,  vmax: 120 },
  },
  poses: {
    HOME:        { base: 90,  shoulder: 90,  elbow: 90, gripper: 40 },
    PICKUP:      { base: 90,  shoulder: 143, elbow: 76 },
    LIFT:        { shoulder: 110, elbow: 78 },
    BIN_RED:     { base: 155, shoulder: 130, elbow: 64 },
    BIN_GREEN:   { base: 120, shoulder: 130, elbow: 64 },
    BIN_BLUE:    { base: 60,  shoulder: 130, elbow: 64 },
    BIN_UNKNOWN: { base: 25,  shoulder: 130, elbow: 64 },
  },
  gripperOpen: 75,
  gripperClosed: 15,
  waitBeforePickup: 1.0,   // s, delay after opening gripper
  sensor: {
    gain: 1450,                 // counts per unit reflectance (integration time + gain lumped)
    chGain: [1.0, 1.08, 0.92],  // relative channel sensitivity R,G,B
    ambient: 6,                 // ambient counts per channel
    clearScale: 0.8,            // clear channel ~ 0.8 * (R+G+B)
    noisePct: 2,                // gaussian noise, % of signal
    padRefl: 0.015,             // empty pad reflectance (matte black)
    samples: 6,                 // readings averaged per identification
  },
  thresholds: {
    redNrMin: 0.45, redNgMax: 0.30,
    greenNgMin: 0.41, greenNrMax: 0.30, greenNbMax: 0.29,
    blueNbMin: 0.42, blueNrMax: 0.25,
    clearMin: 100,
  },
};

export const clone = (o) => JSON.parse(JSON.stringify(o));
const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------- sensors
// Seeded PRNG so runs are repeatable (noise only, never the class).
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TCS34725Model {
  constructor(cfg, seed = 1234) { this.cfg = cfg; this.rand = mulberry32(seed); }
  gauss() {
    let u = 0, v = 0;
    while (u === 0) u = this.rand();
    while (v === 0) v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // reflectance: [r,g,b] 0..1 of the surface under the sensor
  read(reflectance) {
    const s = this.cfg.sensor;
    const ch = [0, 1, 2].map((i) => {
      const ideal = s.ambient + reflectance[i] * s.chGain[i] * s.gain;
      const n = this.gauss() * (ideal * s.noisePct / 100 + 1.5);
      return clamp(Math.round(ideal + n), 0, 65535);
    });
    const cIdeal = s.clearScale * (ch[0] + ch[1] + ch[2]) + s.ambient;
    const c = clamp(Math.round(cIdeal + this.gauss() * (cIdeal * s.noisePct / 100 + 1.5)), 0, 65535);
    return { r: ch[0], g: ch[1], b: ch[2], c };
  }
}

export function normalize(rd) {
  const sum = rd.r + rd.g + rd.b;
  if (sum <= 0) return { nr: 0, ng: 0, nb: 0 };
  return { nr: rd.r / sum, ng: rd.g / sum, nb: rd.b / sum };
}

// Returns { label, n, checks } ; checks lists each rule with pass/fail for the UI.
export function classify(rd, th) {
  const n = normalize(rd);
  const checks = {
    clear: rd.c >= th.clearMin,
    redNr: n.nr > th.redNrMin, redNg: n.ng < th.redNgMax,
    greenNg: n.ng > th.greenNgMin, greenNr: n.nr < th.greenNrMax, greenNb: n.nb < th.greenNbMax,
    blueNb: n.nb > (th.blueNbMin || 0.42), blueNr: n.nr < (th.blueNrMax || 0.25),
  };
  let label = 'UNKNOWN';
  if (!checks.clear) label = 'NO CAP';
  else if (checks.redNr && checks.redNg) label = 'RED';
  else if (checks.greenNg && checks.greenNr && checks.greenNb) label = 'GREEN';
  else if (checks.blueNb && checks.blueNr) label = 'BLUE';
  return { label, n, checks };
}

export function averageReadings(list) {
  const a = { r: 0, g: 0, b: 0, c: 0 };
  for (const x of list) { a.r += x.r; a.g += x.g; a.b += x.b; a.c += x.c; }
  const k = Math.max(1, list.length);
  return { r: Math.round(a.r / k), g: Math.round(a.g / k), b: Math.round(a.b / k), c: Math.round(a.c / k) };
}

// --------------------------------------------------------------- robot
// Servo angle conventions (deg):
//   base:     90 = facing pickup (+z). yaw = -(base-90)  -> 150 swings to LEFT (-x)
//   shoulder: 90 = upper arm vertical, larger leans forward
//   elbow:    forearm angle relative to upper arm (90 = perpendicular)
export const yawOf = (base) => -(base - 90) * D2R;
export const shoulderPitch = (s) => (s - 90) * D2R;
export const elbowPitch = (e) => e * D2R;

export function fk(j) {
  const G = GEOM;
  const yaw = yawOf(j.base), a = shoulderPitch(j.shoulder), b = elbowPitch(j.elbow);
  const er = G.L1 * Math.sin(a), ey = G.H + G.L1 * Math.cos(a);
  const wr = er + G.L2 * Math.sin(a + b), wy = ey + G.L2 * Math.cos(a + b);
  const toW = (r, y) => ({ x: r * Math.sin(yaw), y, z: r * Math.cos(yaw) });
  return {
    shoulder: toW(0, G.H), elbow: toW(er, ey), wrist: toW(wr, wy),
    grip: toW(wr, wy - G.LG), reach: wr, yaw,
  };
}

export const fingerGap = (g) => clamp(GEOM.GRIP.gapAtZero + g * GEOM.GRIP.gapPerDeg, 0.2, 6);

// --------------------------------------------------------- controllers
export class MotionEngine {
  constructor(cfg, initial) {
    this.cfg = cfg;
    this.j = {};
    for (const k of JOINTS) this.j[k] = { pos: initial[k], from: initial[k], to: initial[k], t: 0, dur: 0 };
    this.speed = 1;
    this.warnings = [];
  }
  angles() { const o = {}; for (const k of JOINTS) o[k] = this.j[k].pos; return o; }
  targets() { const o = {}; for (const k of JOINTS) o[k] = this.j[k].to; return o; }
  clampToLimits(k, v) {
    const L = this.cfg.limits[k];
    const c = clamp(v, L.min, L.max);
    if (Math.abs(c - v) > 1e-6) this.warnings.push(`${k} target ${v.toFixed(0)}° clamped to limit ${c}°`);
    return c;
  }
  // Synchronised move: all listed joints start and finish together.
  moveTo(target) {
    let dur = 0;
    const keys = Object.keys(target).filter((k) => JOINTS.includes(k) && target[k] !== undefined);
    const dest = {};
    for (const k of keys) {
      dest[k] = this.clampToLimits(k, Number(target[k]));
      const v = this.cfg.limits[k].vmax * this.speed;
      dur = Math.max(dur, Math.abs(dest[k] - this.j[k].pos) / v);
    }
    // cubic ease peaks at 1.5x average speed: stretch so peak stays <= vmax
    dur = Math.max(0.08, dur * 1.5);
    for (const k of keys) {
      const J = this.j[k];
      J.from = J.pos; J.to = dest[k]; J.t = 0; J.dur = dur;
    }
    return dur;
  }
  halt() { for (const k of JOINTS) { const J = this.j[k]; J.from = J.to = J.pos; J.t = J.dur = 0; } }
  step(dt) {
    for (const k of JOINTS) {
      const J = this.j[k];
      if (J.t >= J.dur) { J.pos = J.to; continue; }
      J.t = Math.min(J.dur, J.t + dt);
      const u = J.t / J.dur;
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      J.pos = J.from + (J.to - J.from) * e;
    }
  }
  settled() { return JOINTS.every((k) => this.j[k].t >= this.j[k].dur); }
}

// ---------------------------------------------------------- simulation
export const CAP_PRESETS = {
  RED:   { name: 'Red',   rgb: [0.78, 0.16, 0.16] },
  GREEN: { name: 'Green', rgb: [0.18, 0.62, 0.27] },
  BLUE:  { name: 'Blue',  rgb: [0.12, 0.37, 0.82] },
};

export function hslToRgb(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
export const rgbToHex = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export function binFrame(binId) {
  const b = BINS[binId];
  if (!b) return null;
  const yaw = -(b.baseDeg - 90) * D2R;
  return { id: binId, yaw, cx: GEOM.TRAY.dist * Math.sin(yaw), cz: GEOM.TRAY.dist * Math.cos(yaw) };
}

export function trayFrame(binId) {
  return binFrame(binId);
}

export function zoneAt(x, z) {
  for (const binId of Object.keys(BINS)) {
    const f = binFrame(binId);
    const dx = x - f.cx, dz = z - f.cz;
    const lx = dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw);
    const lz = dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw);
    const half = GEOM.TRAY.inner / 2;
    if (Math.abs(lx) <= half && Math.abs(lz) <= half) return binId;
  }
  if (Math.hypot(x - GEOM.PAD.x, z - GEOM.PAD.z) <= GEOM.PAD.r) return 'PAD';
  return 'BENCH';
}

function surfaceY(zone) {
  if (zone && zone.startsWith('BIN_')) return GEOM.TRAY.floor;
  if (zone === 'PAD') return GEOM.PAD.h;
  return 0;
}

// ------------------------------------------------------- state machine
export const STATES = [
  'IDLE', 'DETECTING_CAP', 'IDENTIFYING_COLOR', 'OPENING_GRIPPER', 'WAITING_FOR_PICKUP',
  'MOVING_TO_PICKUP', 'CLOSING_GRIPPER', 'LIFTING_CAP', 'ROTATING_TO_BIN',
  'MOVING_TO_DROP_POSITION', 'RELEASING_CAP', 'RETURNING_HOME', 'SORTING_COMPLETE', 'ERROR',
];

export class Simulation {
  constructor(cfg = clone(DEFAULT_CONFIG), seed = 1234) {
    this.cfg = cfg;
    this.sensor = new TCS34725Model(cfg, seed);
    this.rand = mulberry32(seed + 7);
    const home = { ...cfg.poses.HOME };
    this.motion = new MotionEngine(cfg, home);
    this.caps = [];
    this.nextCapId = 1;
    this.heldCap = null;
    this.mode = 'AUTO';
    this.running = false;
    this.paused = false;
    this.time = 0;
    this.listeners = [];
    this.stats = { total: 0, red: 0, green: 0, blue: 0, unknown: 0, cycles: 0, errors: 0 };
    this.reading = { r: 0, g: 0, b: 0, c: 0 };
    this.result = classify(this.reading, cfg.thresholds);
    this.sensorStatus = 'STANDBY';
    this.awaitPadClear = false;
    this.target = null;       // 'BIN_RED' | 'BIN_GREEN' | 'BIN_BLUE' | 'BIN_UNKNOWN'
    this.lastPadMsg = '';
    this.error = '';
    this.seq = null;          // manual sequence player
    this.handlers = this.makeHandlers();
    this.sd = {};
    this.state = 'IDLE';
    this.stateTime = 0;
    this.pollT = 0;
    this.log('info', 'Simulation core initialised. TCS34725 model ready (local simulation, no hardware link).');
  }

  // ---- events
  on(fn) { this.listeners.push(fn); }
  emit(type, data) { for (const f of this.listeners) f(type, data); }
  log(level, msg) { this.emit('log', { level, msg, t: this.time }); }

  // ---- state machine plumbing
  go(next, why) {
    const prev = this.state;
    this.state = next; this.stateTime = 0; this.sd = {};
    this.emit('state', { prev, next });
    if (why) this.log(next === 'ERROR' ? 'error' : 'state', why);
    const h = this.handlers[next];
    if (h && h.enter) h.enter.call(this);
  }
  fail(msg) {
    this.error = msg; this.stats.errors++;
    this.motion.halt();
    this.go('ERROR', `ERROR: ${msg}`);
  }
  move(pose, keys) {
    const t = {};
    for (const k of keys) if (pose[k] !== undefined) t[k] = pose[k];
    this.motion.moveTo(t);
    const a = this.motion.targets();
    this.emit('cmd', a);
    this.flushWarnings();
  }
  flushWarnings() { while (this.motion.warnings.length) this.log('warn', this.motion.warnings.shift()); }

  makeHandlers() {
    const P = () => this.cfg.poses;
    return {
      IDLE: {
        enter() { this.target = null; this.sensorStatus = 'POLLING'; },
        update(dt) {
          this.pollT -= dt;
          const auto = this.mode === 'AUTO' && this.running;
          this.sensorStatus = auto ? 'POLLING' : 'LIVE';
          if (this.pollT > 0) return;
          this.pollT = 0.4;
          if (!auto) { this.readSensor(); return; }   // live dashboard only, no actions
          const rd = this.readSensor();
          const res = this.result;
          if (res.label === 'NO CAP') {
            if (this.awaitPadClear) { this.awaitPadClear = false; this.log('info', 'Pickup pad clear. Ready for next cap.'); }
            this.padMsg('NO CAP DETECTED');
            return;
          }
          if (this.awaitPadClear) { this.padMsg('Rejected cap still on pad. Remove it to continue.'); return; }
          this.lastPadMsg = '';
          this.go('DETECTING_CAP', `Bottle cap detected (clear = ${rd.c} ≥ ${this.cfg.thresholds.clearMin}).`);
        },
      },
      DETECTING_CAP: {
        enter() { this.sd.samples = []; this.sd.t = 0; this.sensorStatus = 'SCANNING'; },
        update(dt) {
          this.sd.t -= dt;
          if (this.sd.t <= 0) { this.sd.samples.push(this.readSensor()); this.sd.t = 0.15; }
          if (this.sd.samples.length >= this.cfg.sensor.samples) this.go('IDENTIFYING_COLOR', `Collected ${this.sd.samples.length} RGBC samples.`);
        },
      },
      IDENTIFYING_COLOR: {
        enter() {
          const avg = averageReadings(this.sd.samples || [this.readSensor()]);
          this.reading = avg;
          this.result = classify(avg, this.cfg.thresholds);
          this.emit('reading', { reading: avg, result: this.result, averaged: true });
          const n = this.result.n;
          this.log('data', `Avg R=${avg.r} G=${avg.g} B=${avg.b} C=${avg.c} | nr=${n.nr.toFixed(3)} ng=${n.ng.toFixed(3)} nb=${n.nb.toFixed(3)}`);
          this.sensorStatus = 'CLASSIFIED';
        },
        update() {
          if (this.stateTime < 0.5) return;
          const L = this.result.label;
          if (L === 'RED' || L === 'GREEN' || L === 'BLUE' || L === 'UNKNOWN') {
            const map = {
              RED: 'BIN_RED',
              GREEN: 'BIN_GREEN',
              BLUE: 'BIN_BLUE',
              UNKNOWN: 'BIN_UNKNOWN'
            };
            this.target = map[L];
            this.log('ok', `${L} colour recognized. Destination: ${this.target} (${BINS[this.target].label}).`);
            this.go('OPENING_GRIPPER');
          } else {
            this.log('warn', 'Cap lost during identification (clear below threshold).');
            this.go('IDLE');
          }
        },
      },
      OPENING_GRIPPER: {
        enter() { this.move({ gripper: this.cfg.gripperOpen }, ['gripper']); },
        update() { if (this.motion.settled()) { this.log('state', 'Gripper opened.'); this.go('WAITING_FOR_PICKUP'); } },
      },
      WAITING_FOR_PICKUP: {
        update() { if (this.stateTime >= this.cfg.waitBeforePickup) this.go('MOVING_TO_PICKUP', 'Moving to pickup position.'); },
      },
      MOVING_TO_PICKUP: {
        enter() { this.move(P().PICKUP, ['base', 'shoulder', 'elbow']); },
        update() { if (this.motion.settled()) this.go('CLOSING_GRIPPER'); },
      },
      CLOSING_GRIPPER: {
        enter() { this.move({ gripper: this.cfg.gripperClosed }, ['gripper']); },
        update() {
          if (this.heldCap && this.motion.settled()) { this.log('ok', 'Gripper closed. Cap secured.'); this.go('LIFTING_CAP'); return; }
          if (this.motion.settled()) {
            const c = this.padCap();
            const g = fk(this.motion.angles()).grip;
            const d = c ? `grip point ${Math.hypot(g.x - c.pos.x, g.z - c.pos.z).toFixed(1)} cm from cap centre (horiz), ${(g.y - c.pos.y).toFixed(1)} cm vertical` : 'no cap on pad';
            this.fail(`Grip failed: ${d}. Recalibrate PICKUP pose.`);
          }
        },
      },
      LIFTING_CAP: {
        enter() { this.move(P().LIFT, ['shoulder', 'elbow']); },
        update() {
          if (!this.motion.settled()) return;
          this.log('state', 'Cap lifted.');
          this.go('ROTATING_TO_BIN', `Rotating to ${this.target}.`);
        },
      },
      ROTATING_TO_BIN: {
        enter() {
          const targetPose = P()[this.target] || P().HOME;
          this.move({ base: targetPose.base }, ['base']);
        },
        update() { if (this.motion.settled()) this.go('MOVING_TO_DROP_POSITION'); },
      },
      MOVING_TO_DROP_POSITION: {
        enter() {
          const targetPose = P()[this.target] || P().HOME;
          this.move({ shoulder: targetPose.shoulder, elbow: targetPose.elbow }, ['shoulder', 'elbow']);
        },
        update() { if (this.motion.settled()) this.go('RELEASING_CAP'); },
      },
      RELEASING_CAP: {
        enter() {
          this.sd.cap = this.heldCap;
          if (!this.sd.cap) { this.fail('No cap in gripper at release.'); return; }
          this.move({ gripper: this.cfg.gripperOpen }, ['gripper']); },
        update() {
          const cap = this.sd.cap;
          if (!this.motion.settled() || !cap || cap.state === 'held' || cap.state === 'falling') return;
          if (this.sd.done) return;
          this.sd.done = true;
          if (cap.zone === this.target) {
            this.stats.total++;
            const binInfo = BINS[this.target];
            if (binInfo && this.stats[binInfo.key] !== undefined) {
              this.stats[binInfo.key]++;
            }
            this.emit('stats');
            this.log('ok', `Cap released into ${this.target} (${binInfo ? binInfo.label : ''}).`);
            this.go('RETURNING_HOME', 'Returning HOME.');
          } else {
            this.fail(`Cap landed in ${cap.zone} instead of ${this.target} zone. Check ${this.target} pose.`);
          }
        },
      },
      RETURNING_HOME: {
        enter() { this.move(P().HOME, ['base', 'shoulder', 'elbow', 'gripper']); },
        update() { if (this.motion.settled()) this.go('SORTING_COMPLETE'); },
      },
      SORTING_COMPLETE: {
        enter() { this.stats.cycles++; this.emit('stats'); this.log('ok', 'Sorting complete.'); },
        update() { if (this.stateTime >= 0.6) this.go('IDLE'); },
      },
      ERROR: { enter() { this.sensorStatus = 'HALTED'; }, update() {} },
    };
  }

  padMsg(m) { if (this.lastPadMsg !== m) { this.lastPadMsg = m; this.log('info', m); } }

  // ---- sensor
  padCap() {
    return this.caps.find((c) => c.state === 'resting' && c.zone === 'PAD') || null;
  }
  readSensor() {
    const c = this.padCap();
    const refl = c ? c.rgb : [this.cfg.sensor.padRefl, this.cfg.sensor.padRefl, this.cfg.sensor.padRefl];
    const rd = this.sensor.read(refl);
    this.reading = rd;
    this.result = classify(rd, this.cfg.thresholds);
    this.emit('reading', { reading: rd, result: this.result, averaged: false });
    return rd;
  }

  // ---- caps
  spawnCap(kind, hex, onConveyor = true) {
    if (onConveyor) {
      const nearInfeed = this.caps.find((c) => Math.hypot(c.pos.x - GEOM.CONVEYOR.startX, c.pos.z - GEOM.CONVEYOR.startZ) < GEOM.CAP.r * 2.5);
      if (nearInfeed) { this.log('warn', 'Conveyor infeed is currently occupied.'); return null; }
    } else {
      const occupied = this.caps.find((c) => (c.zone === 'PAD' && c.state === 'resting') || c.state === 'spawning');
      if (occupied) { this.log('warn', 'Pickup position occupied. Wait or remove the current cap first.'); return null; }
    }
    let rgb, name;
    if (CAP_PRESETS[kind]) { rgb = [...CAP_PRESETS[kind].rgb]; name = CAP_PRESETS[kind].name; }
    else if (kind === 'RANDOM') {
      rgb = hslToRgb(this.rand(), 0.55 + this.rand() * 0.4, 0.3 + this.rand() * 0.25);
      name = 'Random';
    } else if (kind === 'CUSTOM') { rgb = hexToRgb(hex); name = 'Custom'; }
    else return null;

    const startX = onConveyor ? GEOM.CONVEYOR.startX : GEOM.PAD.x;
    const startZ = onConveyor ? GEOM.CONVEYOR.startZ : GEOM.PAD.z;
    const startY = onConveyor ? (GEOM.CONVEYOR.height + GEOM.CAP.h / 2) : (GEOM.PAD.h + GEOM.CAP.h / 2 + 5);

    const cap = {
      id: this.nextCapId++, name, rgb, hex: rgbToHex(rgb),
      pos: { x: startX, y: startY, z: startZ },
      vy: 0, state: onConveyor ? 'conveyor' : 'spawning', zone: onConveyor ? null : 'PAD',
    };
    this.caps.push(cap);
    this.emit('caps');
    this.log('info', `${name} cap (${cap.hex}) loaded ${onConveyor ? 'onto conveyor belt' : 'at pickup pad'}.`);
    return cap;
  }
  removePadCap() {
    const c = this.padCap() || this.caps.find((c) => c.state === 'conveyor' && Math.hypot(c.pos.x - GEOM.PAD.x, c.pos.z - GEOM.PAD.z) < 2.0);
    if (!c) { this.log('info', 'No cap at pickup station.'); return; }
    this.caps = this.caps.filter((x) => x !== c);
    this.emit('caps');
    this.log('info', 'Operator removed cap from pickup station.');
  }
  clearTrays() {
    const n = this.caps.length;
    this.caps = this.caps.filter((c) => !(c.state === 'resting' && (c.zone && (c.zone.startsWith('BIN_') || c.zone === 'BENCH'))));
    this.emit('caps');
    this.log('info', `Sorting containers cleared (${n - this.caps.length} caps removed).`);
  }

  updateCaps(dt) {
    const G = GEOM;
    const j = this.motion.angles();
    const f = fk(j);
    const gap = fingerGap(j.gripper);
    const dia = 2 * G.CAP.r;

    // conveyor motion
    const conv = G.CONVEYOR;
    const padOccupied = this.caps.some((c) => c.zone === 'PAD' && c.state === 'resting');
    for (const c of this.caps) {
      if (c.state === 'conveyor') {
        const distToPad = c.pos.z - G.PAD.z;
        if (distToPad <= 0.05) {
          c.pos.x = G.PAD.x;
          c.pos.z = G.PAD.z;
          c.pos.y = G.PAD.h + G.CAP.h / 2;
          c.state = 'resting';
          c.zone = 'PAD';
          this.emit('caps');
          this.log('info', `${c.name} cap arrived at inspection station.`);
        } else {
          // move along belt towards PAD unless blocked by another cap ahead
          let canMove = !padOccupied || distToPad > 2.8;
          for (const o of this.caps) {
            if (o === c) continue;
            if (Math.abs(o.pos.x - c.pos.x) < 2.0 && o.pos.z < c.pos.z && (c.pos.z - o.pos.z) < 3.2) {
              canMove = false;
              break;
            }
          }
          if (canMove) {
            c.pos.z -= conv.speed * dt;
          }
        }
      }
    }

    // grip / release
    if (this.heldCap) {
      const c = this.heldCap;
      c.pos = { ...f.grip };
      if (gap >= dia + 0.3) {
        c.state = 'falling'; c.vy = 0; this.heldCap = null;
        this.emit('caps'); this.log('state', 'Gripper released cap.');
      }
    } else if (gap <= dia) {
      for (const c of this.caps) {
        if (c.state !== 'resting') continue;
        const h = Math.hypot(f.grip.x - c.pos.x, f.grip.z - c.pos.z);
        const v = Math.abs(f.grip.y - c.pos.y);
        if (h <= G.CAPTURE.horiz && v <= G.CAPTURE.vert && this.sd_gripWasOpen) {
          c.state = 'held'; c.zone = null; this.heldCap = c;
          this.emit('caps'); this.log('state', 'Fingers in contact with cap.');
          break;
        }
      }
    }
    // gripper must be open wider than the cap before it can capture one
    this.sd_gripWasOpen = gap > dia + 0.2 ? true : (gap <= dia ? false : this.sd_gripWasOpen);
    if (this.heldCap) this.sd_gripWasOpen = false;
    // falling / spawning caps
    for (const c of this.caps) {
      if (c.state !== 'falling' && c.state !== 'spawning') continue;
      c.vy -= 981 * dt;
      c.pos.y += c.vy * dt;
      const zone = zoneAt(c.pos.x, c.pos.z);
      let floor = surfaceY(zone) + G.CAP.h / 2;
      for (const o of this.caps) {
        if (o === c || o.state !== 'resting') continue;
        if (Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z) < 2 * G.CAP.r * 0.9) floor = Math.max(floor, o.pos.y + G.CAP.h);
      }
      if (c.pos.y <= floor) {
        c.pos.y = floor; c.vy = 0; c.state = 'resting'; c.zone = zone;
        this.emit('caps');
        const binInfo = BINS[zone];
        if (binInfo) this.log('info', `Cap landed in ${binInfo.label} container.`);
        else if (zone !== 'PAD') this.log('info', `Cap landed: ${zone === 'BENCH' ? 'on bench (outside containers)' : zone}.`);
      }
    }
  }

  // ---- manual sequence player (predefined demo motion, no gripping logic needed)
  playSequence() {
    if (this.mode !== 'MANUAL') { this.log('warn', 'Switch to MANUAL mode to play the movement sequence.'); return; }
    const P = this.cfg.poses;
    this.seq = {
      i: -1, steps: [
        ['HOME', P.HOME], ['PICKUP', { ...P.PICKUP, gripper: this.cfg.gripperOpen }], ['LIFT', P.LIFT],
        ['BIN_RED', P.BIN_RED], ['BIN_GREEN', P.BIN_GREEN], ['BIN_BLUE', P.BIN_BLUE], ['BIN_UNKNOWN', P.BIN_UNKNOWN],
        ['HOME', P.HOME],
      ],
    };
    this.log('info', 'Playing predefined movement sequence across all 4 bins.');
  }
  stopSequence() { if (this.seq) { this.seq = null; this.log('info', 'Sequence stopped.'); } }

  // ---- controls
  setMode(m) {
    if (m === this.mode) return;
    if (m === 'MANUAL' && this.state !== 'IDLE' && this.state !== 'ERROR') {
      this.motion.halt();
      this.log('warn', `Auto cycle aborted in ${this.state} (switched to MANUAL).`);
      this.go('IDLE');
    }
    this.mode = m; this.seq = null;
    this.log('info', `${m} mode.`);
    this.emit('mode');
  }
  start() {
    if (this.state === 'ERROR') { this.log('warn', 'Clear the error with RESET first.'); return; }
    this.setMode('AUTO');
    if (!this.running) { this.running = true; this.paused = false; this.log('info', 'Automatic sorting started. Polling sensor.'); }
    this.emit('mode');
  }
  stop() { this.running = false; this.emit('mode'); }
  setPaused(p) { this.paused = p; this.log('info', p ? 'Simulation paused.' : 'Simulation resumed.'); this.emit('mode'); }
  home() {
    if (this.mode === 'AUTO' && this.running && this.state !== 'IDLE' && this.state !== 'ERROR') {
      this.log('warn', 'Robot busy. Switch to MANUAL or RESET to send HOME.'); return;
    }
    this.seq = null;
    this.move(this.cfg.poses.HOME, JOINTS);
    this.log('info', 'Moving to HOME.');
  }
  reset() {
    this.seq = null; this.error = ''; this.running = false; this.paused = false;
    this.awaitPadClear = false; this.lastPadMsg = '';
    if (this.heldCap) { this.heldCap.state = 'falling'; this.heldCap = null; }
    this.motion.halt();
    this.go('IDLE', 'Controller reset.');
    this.move(this.cfg.poses.HOME, JOINTS);
    this.emit('mode');
  }
  resetScene() {
    this.caps = []; this.heldCap = null;
    this.stats = { total: 0, red: 0, green: 0, unknown: 0, cycles: 0, errors: 0 };
    this.reset();
    this.emit('caps'); this.emit('stats');
    this.log('info', 'Scene reset: caps removed, statistics cleared.');
  }
  manualJoint(k, v) {
    if (this.mode !== 'MANUAL') return;
    this.seq = null;
    this.motion.moveTo({ [k]: v });
    this.flushWarnings();
  }

  // ---- main step
  step(dt) {
    if (this.paused) return;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.stateTime += dt;
    this.motion.step(dt);
    if (this.seq && this.motion.settled()) {
      this.seq.i++;
      if (this.seq.i >= this.seq.steps.length) { this.seq = null; this.log('info', 'Sequence finished.'); }
      else {
        const [name, pose] = this.seq.steps[this.seq.i];
        this.move(pose, JOINTS);
        this.log('state', `Sequence → ${name}`);
      }
    }
    this.updateCaps(dt);
    const h = this.handlers[this.state];
    if (h.update) h.update.call(this, dt);
  }
}
