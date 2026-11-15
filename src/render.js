// =====================================================================
// visualizations/  Three.js scene: workbench, hierarchical 4-DOF arm,
// sensor, trays, caps. Reads simulation state only; never drives it.
// =====================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GEOM, BINS, yawOf, shoulderPitch, elbowPitch, fingerGap, fk, binFrame } from './core.js';

const MAT = {
  mdf: new THREE.MeshStandardMaterial({ color: 0xb8915f, roughness: 0.85 }),
  mdfLight: new THREE.MeshStandardMaterial({ color: 0xc9a473, roughness: 0.8 }),
  servo: new THREE.MeshStandardMaterial({ color: 0x1f5fbf, roughness: 0.45, metalness: 0.05 }),
  horn: new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 }),
  screw: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.35, metalness: 0.8 }),
  acrylic: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.25, metalness: 0.1 }),
  bench: new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.95 }),
  pad: new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.95 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.9 }),
  pcbBlue: new THREE.MeshStandardMaterial({ color: 0x0e6f80, roughness: 0.6 }),
  pcbPurple: new THREE.MeshStandardMaterial({ color: 0x5a2d8c, roughness: 0.55 }),
  chip: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.5 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xc7ccd2, roughness: 0.3, metalness: 0.9 }),
  bracket: new THREE.MeshStandardMaterial({ color: 0x3b4149, roughness: 0.6, metalness: 0.3 }),
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
}
function cyl(r, h, mat, seg = 32) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.castShadow = true; m.receiveShadow = true; return m;
}
// SG90: body 2.3 x 1.22 x 2.25 cm with mounting tabs; shaft along +x of returned group
function sg90(withHorn = true) {
  const g = new THREE.Group();
  const body = box(1.22, 2.25, 2.3, MAT.servo); g.add(body);
  g.add(box(1.22, 0.25, 3.2, MAT.servo, 0, 0.45, 0));          // tabs
  const top = cyl(0.55, 0.45, MAT.servo); top.rotation.z = Math.PI / 2; top.position.set(0.8, 0, 0.55); g.add(top);
  if (withHorn) {
    const horn = cyl(0.42, 0.15, MAT.horn); horn.rotation.z = Math.PI / 2; horn.position.set(1.08, 0, 0.55); g.add(horn);
  }
  return g;
}
function label(text, color = '#9fb3c8', w = 12, h = 2.2) {
  const c = document.createElement('canvas'); c.width = 512; c.height = Math.round(512 * h / w);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color; ctx.font = `600 ${Math.round(c.height * 0.5)}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4; tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.03; return m;
}

export class SceneView {
  constructor(container, sim) {
    this.sim = sim; this.container = container;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14171b);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 600);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 12; this.controls.maxDistance = 160;
    this.setView('persp');

    scene.add(new THREE.HemisphereLight(0xdde6f5, 0x1a1d22, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(22, 48, 30); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 5, far: 140 });
    sun.shadow.bias = -0.0005; sun.shadow.camera.updateProjectionMatrix(); scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8fb4ff, 0.35); fill.position.set(-30, 20, -20); scene.add(fill);

    this.buildBench();
    this.buildArm();
    this.buildConveyor();
    this.buildSensor();
    this.buildTrays();
    this.capMeshes = new Map();

    const ro = new ResizeObserver(() => this.resize()); ro.observe(container); this.resize();
  }

  setView(v) {
    const C = this.camera, T = this.controls.target;
    const views = {
      persp: [[0, 38, 54], [0, 4, 6]], top: [[0, 78, 6.01], [0, 0, 6]],
      front: [[0, 12, 62], [0, 6, 4]], side: [[60, 16, 6], [0, 6, 6]],
    };
    const [p, t] = views[v] || views.persp;
    C.position.set(...p); T.set(...t); this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth, h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  buildBench() {
    const s = this.scene;
    s.add(box(96, 2, 80, MAT.bench, 0, -1, 14));
    const grid = new THREE.GridHelper(96, 48, 0x3d4652, 0x2c323a); grid.position.set(0, 0.012, 14); grid.material.transparent = true; grid.material.opacity = 0.7; s.add(grid);
    // robot mounting plate with standoffs
    s.add(box(16, 0.4, 14, MAT.acrylic, 0, 0.2, -1.5));
    for (const [x, z] of [[-7, -7.5], [7, -7.5], [-7, 4.5], [7, 4.5]]) { const sc = cyl(0.35, 0.2, MAT.screw, 12); sc.position.set(x, 0.5, z); s.add(sc); }
    // Arduino UNO + battery pack on the bench (static props)
    const uno = new THREE.Group(); uno.position.set(-16, 0, -11);
    uno.add(box(6.86, 0.16, 5.34, MAT.pcbBlue, 0, 0.6, 0));
    for (const [x, z] of [[-3, -2.2], [3, -2.2], [-3, 2.2], [3, 2.2]]) { const st = cyl(0.18, 0.52, MAT.metal, 10); st.position.set(x, 0.26, z); uno.add(st); }
    uno.add(box(3.4, 0.35, 0.9, MAT.chip, 0.6, 0.86, 0.8));
    uno.add(box(1.2, 1.0, 1.6, MAT.metal, -3.1, 1.1, -1.2));
    uno.add(box(1.4, 1.1, 0.9, MAT.chip, -3.0, 1.1, 1.8));
    uno.add(box(4.6, 0.8, 0.25, MAT.chip, 0.6, 1.08, -2.45));
    uno.add(box(4.0, 0.8, 0.25, MAT.chip, 0.9, 1.08, 2.45));
    s.add(uno); const ul = label('ARDUINO UNO', '#7d8b99', 8, 1.4); ul.position.set(-16, 0.03, -6.8); s.add(ul);
    const bat = new THREE.Group(); bat.position.set(16, 0, -11);
    bat.add(box(7.8, 1.0, 4.4, MAT.chip, 0, 0.5, 0));
    for (const z of [-1.0, 1.0]) { const c = cyl(0.9, 6.5, new THREE.MeshStandardMaterial({ color: 0x2f6f3e, roughness: 0.5 }), 24); c.rotation.z = Math.PI / 2; c.position.set(0, 1.4, z); bat.add(c); }
    bat.add(box(2.4, 0.4, 2.2, MAT.pcbBlue, -7, 0.2, 0));
    s.add(bat); const bl = label('2S 7.4V → 5V REG', '#7d8b99', 10, 1.4); bl.position.set(16, 0.03, -6.8); s.add(bl);
  }

  buildConveyor() {
    const s = this.scene, C = GEOM.CONVEYOR;
    const g = new THREE.Group();
    const len = C.startZ - C.endZ; // ~23.5 cm
    const midZ = (C.startZ + C.endZ) / 2;
    // belt bed
    const bed = box(C.width, C.height, len, MAT.acrylic, 0, C.height / 2, midZ);
    g.add(bed);
    // moving belt surface texture
    const beltMat = new THREE.MeshStandardMaterial({ color: 0x1f242d, roughness: 0.85, metalness: 0.1 });
    const belt = new THREE.Mesh(new THREE.PlaneGeometry(C.width - 0.4, len - 0.2), beltMat);
    belt.rotation.x = -Math.PI / 2;
    belt.position.set(0, C.height + 0.015, midZ);
    g.add(belt);
    this.conveyorBelt = belt;

    // aluminum guide rails along sides
    for (const side of [-1, 1]) {
      const rail = box(0.3, 1.2, len, MAT.metal, side * (C.width / 2 + 0.15), 0.6, midZ);
      g.add(rail);
      // guide supports / legs
      for (const z of [C.endZ + 2, midZ, C.startZ - 2]) {
        const leg = cyl(0.35, C.height, MAT.bracket, 12);
        leg.position.set(side * (C.width / 2 + 0.15), C.height / 2, z);
        g.add(leg);
      }
    }
    // drive roller at the infeed end
    const roller = cyl(C.width / 2 - 0.1, 0.7, MAT.metal, 24);
    roller.rotation.z = Math.PI / 2;
    roller.position.set(0, C.height / 2, C.startZ);
    g.add(roller);

    const cl = label('CONVEYOR INFEED → SENSOR', '#7aa2d6', 15, 1.6);
    cl.position.set(0, 0.03, C.startZ + 4.0);
    s.add(cl);

    s.add(g);
  }

  buildArm() {
    const G = GEOM, s = this.scene;
    const baseTop = 3.4;
    const root = new THREE.Group(); s.add(root);
    const housing = cyl(5, baseTop - 0.4, MAT.mdf, 48); housing.position.y = 0.4 + (baseTop - 0.4) / 2; root.add(housing);
    const bs = sg90(false); bs.rotation.z = Math.PI / 2; bs.position.set(0, 2.0, -5.2); root.add(bs);

    const yaw = this.yawG = new THREE.Group(); yaw.position.y = baseTop; root.add(yaw);
    const tt = cyl(4.6, 0.5, MAT.mdfLight, 48); tt.position.y = 0.25; yaw.add(tt);
    const brH = G.H - baseTop + 0.9;
    for (const x of [-2.0, 2.0]) yaw.add(box(0.4, brH, 3.0, MAT.mdf, x, 0.5 + brH / 2 - 0.1, 0));
    const ss = sg90(); ss.position.set(2.85, G.H - baseTop, -0.55); yaw.add(ss);

    const sh = this.shoulderG = new THREE.Group(); sh.position.y = G.H - baseTop; yaw.add(sh);
    const hub = cyl(0.9, 3.6, MAT.horn, 24); hub.rotation.z = Math.PI / 2; sh.add(hub);
    for (const x of [-1.3, 1.3]) sh.add(box(0.35, G.L1 + 1.6, 1.6, MAT.mdfLight, x, G.L1 / 2, 0));
    for (const y of [G.L1 * 0.33, G.L1 * 0.66]) { const sp = cyl(0.22, 2.6, MAT.metal, 10); sp.rotation.z = Math.PI / 2; sp.position.y = y; sh.add(sp); }

    const el = this.elbowG = new THREE.Group(); el.position.y = G.L1; sh.add(el);
    const es = sg90(); es.position.set(2.15, 0, -0.55); el.add(es);
    const eh = cyl(0.75, 3.0, MAT.horn, 24); eh.rotation.z = Math.PI / 2; el.add(eh);
    for (const x of [-0.85, 0.85]) el.add(box(0.35, G.L2 + 1.2, 1.4, MAT.mdf, x, G.L2 / 2, 0));
    const fsp = cyl(0.2, 1.8, MAT.metal, 10); fsp.rotation.z = Math.PI / 2; fsp.position.y = G.L2 * 0.5; el.add(fsp);

    const wr = this.wristG = new THREE.Group(); wr.position.y = G.L2; el.add(wr);
    const wh = cyl(0.6, 2.2, MAT.horn, 20); wh.rotation.z = Math.PI / 2; wr.add(wh);
    wr.add(box(1.0, 1.6, 1.0, MAT.mdf, 0, -0.8, 0));
    wr.add(box(5.0, 0.4, 2.6, MAT.mdfLight, 0, -1.7, 0));       // gripper deck
    const gs = sg90(); gs.rotation.z = Math.PI / 2; gs.position.set(-0.4, -1.0, -1.9); gs.scale.setScalar(0.9); wr.add(gs);
    const rail = cyl(0.12, 5.2, MAT.metal, 8); rail.rotation.z = Math.PI / 2; rail.position.set(0, -2.1, 0); wr.add(rail);
    this.fingers = [];
    const fTop = -1.9, fBot = -(G.LG + 0.5);
    for (const side of [-1, 1]) {
      const f = new THREE.Group();
      f.add(box(0.35, fTop - fBot, 1.6, MAT.mdf, 0, (fTop + fBot) / 2, 0));
      f.add(box(0.15, 2.0, 1.4, MAT.rubber, -side * 0.25, fBot + 1.1, 0));
      f.userData.side = side; wr.add(f); this.fingers.push(f);
    }
    // grip point marker
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
    this.marker.visible = false; s.add(this.marker);
  }

  buildSensor() {
    const s = this.scene, P = GEOM.PAD;
    const pad = cyl(P.r, P.h, MAT.pad, 40); pad.position.set(P.x, P.h / 2, P.z); s.add(pad);
    const ring = new THREE.Mesh(new THREE.RingGeometry(P.r + 0.15, P.r + 0.4, 48), new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8 }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(P.x, 0.02, P.z); s.add(ring); this.padRing = ring;
    const pl = label('PICKUP · TCS34725', '#7fa7d9', 11, 1.6); pl.position.set(0, 0.03, P.z + 9.2); s.add(pl);
    // bracket
    const sx = 0, sy = 6.3, sz = P.z + 2.4;
    s.add(box(0.8, 7.4, 0.8, MAT.bracket, 0, 3.7, P.z + 6.2));
    s.add(box(0.6, 0.6, 4.4, MAT.bracket, 0, 7.1, P.z + 4.2));
    s.add(box(2.2, 0.3, 2.2, MAT.bracket, 0, 0.15, P.z + 6.2));
    const head = this.sensorHead = new THREE.Group(); head.position.set(sx, sy, sz);
    const dir = new THREE.Vector3(P.x - sx, P.h + GEOM.CAP.h - sy, P.z - sz);
    const tilt = Math.atan2(-dir.z, -dir.y); head.rotation.x = tilt;
    head.add(box(2.0, 0.16, 2.0, MAT.pcbPurple));
    head.add(box(0.5, 0.18, 0.5, MAT.chip, 0.35, -0.12, 0));
    this.led = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6d8, emissiveIntensity: 0.2 }));
    this.led.position.set(-0.4, -0.14, 0); head.add(this.led);
    const len = dir.length();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.9, len, 40, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x9ad1ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    cone.position.y = -len / 2; head.add(cone); this.cone = cone;
    this.ledLight = new THREE.PointLight(0xfff3d0, 0, 12, 2); this.ledLight.position.set(0, -0.5, 0); head.add(this.ledLight);
    s.add(head);
  }

  buildTrays() {
    const T = GEOM.TRAY, t = 0.4, outer = T.inner + 2 * t;
    for (const [binId, b] of Object.entries(BINS)) {
      const f = binFrame(binId);
      const g = new THREE.Group(); g.position.set(f.cx, 0, f.cz); g.rotation.y = f.yaw;
      g.add(box(outer, T.floor, outer, MAT.mdf, 0, T.floor / 2, 0));
      const hw = T.inner / 2 + t / 2;
      g.add(box(outer, T.wall, t, MAT.mdfLight, 0, T.wall / 2, hw));
      g.add(box(outer, T.wall, t, MAT.mdfLight, 0, T.wall / 2, -hw));
      g.add(box(t, T.wall, T.inner, MAT.mdfLight, hw, T.wall / 2, 0));
      g.add(box(t, T.wall, T.inner, MAT.mdfLight, -hw, T.wall / 2, 0));

      const rimCol = new THREE.Color(b.color);
      const rimMat = new THREE.MeshStandardMaterial({ color: rimCol, roughness: 0.5 });
      for (const [w, d, x, z] of [[outer, t, 0, hw], [outer, t, 0, -hw], [t, T.inner, hw, 0], [t, T.inner, -hw, 0]]) {
        const st = box(w + 0.02, 0.16, d + 0.02, rimMat, x, T.wall + 0.08, z); g.add(st);
      }
      const lb = label(b.label.toUpperCase(), b.color, 8, 1.5);
      lb.position.set(f.cx, 0.03, f.cz + hw + 2.2);
      this.scene.add(lb);
      this.scene.add(g);
    }
  }

  syncCaps() {
    const sim = this.sim, seen = new Set();
    for (const c of sim.caps) {
      seen.add(c.id);
      let m = this.capMeshes.get(c.id);
      if (!m) {
        m = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(c.hex), roughness: 0.45 });
        const body = new THREE.Mesh(new THREE.CylinderGeometry(GEOM.CAP.r, GEOM.CAP.r * 0.97, GEOM.CAP.h, 48), mat);
        body.castShadow = body.receiveShadow = true; m.add(body);
        const top = new THREE.Mesh(new THREE.CircleGeometry(GEOM.CAP.r * 0.82, 40), new THREE.MeshStandardMaterial({ color: new THREE.Color(c.hex).multiplyScalar(0.8), roughness: 0.6 }));
        top.rotation.x = -Math.PI / 2; top.position.y = GEOM.CAP.h / 2 + 0.005; m.add(top);
        for (let i = 0; i < 24; i++) {     // knurled ridges
          const a = (i / 24) * Math.PI * 2;
          const rb = new THREE.Mesh(new THREE.BoxGeometry(0.12, GEOM.CAP.h * 0.8, 0.12), mat);
          rb.position.set(Math.cos(a) * GEOM.CAP.r, 0, Math.sin(a) * GEOM.CAP.r); m.add(rb);
        }
        this.scene.add(m); this.capMeshes.set(c.id, m);
      }
      m.position.set(c.pos.x, c.pos.y, c.pos.z);
    }
    for (const [id, m] of this.capMeshes) if (!seen.has(id)) { this.scene.remove(m); this.capMeshes.delete(id); }
  }

  sync(time) {
    const sim = this.sim, j = sim.motion.angles();
    const a = shoulderPitch(j.shoulder), b = elbowPitch(j.elbow);
    this.yawG.rotation.y = yawOf(j.base);
    this.shoulderG.rotation.x = a;
    this.elbowG.rotation.x = b;
    this.wristG.rotation.x = -(a + b);
    let gap = fingerGap(j.gripper);
    if (sim.heldCap) gap = Math.max(gap, 2 * GEOM.CAP.r);
    for (const f of this.fingers) f.position.x = f.userData.side * (gap / 2 + 0.175);
    const g = fk(j).grip; this.marker.position.set(g.x, g.y, g.z);
    // sensor visuals
    const st = sim.sensorStatus;
    const scanning = st === 'SCANNING';
    const on = scanning || st === 'POLLING' || st === 'LIVE' || st === 'CLASSIFIED';
    this.led.material.emissiveIntensity = on ? (scanning ? 1.6 : 0.9) : 0.15;
    this.ledLight.intensity = on ? (scanning ? 6 : 2.5) : 0;
    this.cone.material.opacity = scanning ? 0.10 + 0.08 * Math.sin(time * 14) : (st === 'CLASSIFIED' ? 0.06 : 0);
    this.padRing.material.color.setHex(scanning ? 0x38bdf8 : (sim.state === 'ERROR' ? 0xef4444 : 0x3b82f6));
    this.syncCaps();
    if (this.conveyorBelt) {
      const activeConveyor = this.sim.caps.some((c) => c.state === 'conveyor');
      const offset = activeConveyor ? (time * 1.5) % 1 : 0;
      this.conveyorBelt.material.color.setHex(activeConveyor ? 0x28303d : 0x1f242d);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
