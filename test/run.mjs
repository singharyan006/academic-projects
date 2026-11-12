import { Simulation, fk, classify, TCS34725Model, DEFAULT_CONFIG, clone, CAP_PRESETS, GEOM, BINS } from '../src/core.js';
const cfg = clone(DEFAULT_CONFIG);
// classification of presets, 200 noisy readings each
const s = new TCS34725Model(cfg, 99);
for (const [k, v] of Object.entries(CAP_PRESETS)) {
  const counts = {}; for (let i = 0; i < 500; i++) { const l = classify(s.read(v.rgb), cfg.thresholds).label; counts[l] = (counts[l] || 0) + 1; }
  console.log('preset', k, counts);
}
{ const counts = {}; for (let i = 0; i < 500; i++) { const r = cfg.sensor.padRefl; const l = classify(s.read([r,r,r]), cfg.thresholds).label; counts[l]=(counts[l]||0)+1;} console.log('empty pad', counts); }
// pose checks
for (const [n, p] of Object.entries(cfg.poses)) { const j = { ...cfg.poses.HOME, ...p }; const g = fk(j).grip; console.log(n, Object.values(g).map(v=>v.toFixed(2)).join(', ')); }

function run(kind, maxT = 40) {
  const sim = new Simulation(clone(DEFAULT_CONFIG), 5);
  const trace = []; let logs = [];
  sim.on((t, d) => { if (t === 'state') trace.push(d.next); if (t === 'log') logs.push(`[${d.t.toFixed(2)}] ${d.level}: ${d.msg}`); });
  sim.start();
  if (kind) sim.spawnCap(kind, null, false); // direct pad placement for quick test
  for (let t = 0; t < maxT; t += 1/60) sim.step(1/60);
  return { sim, trace, logs };
}
for (const k of ['RED', 'GREEN', 'BLUE', null, 'RANDOM']) {
  const { sim, trace, logs } = run(k);
  console.log('\n===', k, '| final', sim.state, '| stats', JSON.stringify(sim.stats));
  console.log(trace.join(' > '));
  console.log('caps:', sim.caps.map(c => `${c.name}@${c.zone}(${c.pos.x.toFixed(1)},${c.pos.y.toFixed(2)},${c.pos.z.toFixed(1)})`).join(' '));
  if (k === 'RED') console.log(logs.join('\n'));
}

// test conveyor feed run
{
  const sim = new Simulation(clone(DEFAULT_CONFIG), 12);
  sim.start();
  sim.spawnCap('BLUE', null, true); // on conveyor
  for (let t = 0; t < 30; t += 1/60) sim.step(1/60);
  console.log('\nconveyor blue sort test:', sim.state, JSON.stringify(sim.stats), sim.caps.map(c => `${c.name}@${c.zone}`));
}
