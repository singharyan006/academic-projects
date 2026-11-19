// Entry: wires simulation core, 3D view and dashboard; runs the fixed-step loop.
import { Simulation } from './core.js';
import { SceneView } from './render.js';
import { Dashboard } from './ui.js';

const sim = new Simulation();
const view = new SceneView(document.getElementById('vp'), sim);
const ui = new Dashboard(sim, view);
window.__twinOK = true;
window.__twin = { sim, view, ui };
sim.log('info', 'Sensor initialized: TCS34725 model (simulated, I²C 0x29). Press START or run a demo.');

const STEP = 1 / 120;
let last = performance.now();
function frame(now) {
  let dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  ui.demo.update(sim.paused ? 0 : dt);
  while (dt > 1e-6) { const h = Math.min(STEP, dt); sim.step(h); dt -= h; }
  view.sync(now / 1000);
  ui.refresh(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
