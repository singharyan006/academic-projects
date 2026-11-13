// components/HardwareDiagram: schematic-style wiring diagram (SVG string)
const C = { raw: '#f97316', v5: '#ef4444', gnd: '#9ca3af', sig: '#facc15', sda: '#38bdf8', scl: '#a78bfa', box: '#1c2025', edge: '#3a424c', tx: '#d6dce4', tx2: '#8a96a3' };

function blk(x, y, w, h, title, sub, accent) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${C.box}" stroke="${accent || C.edge}" stroke-width="1.5"/>
  <text x="${x + 12}" y="${y + 22}" fill="${C.tx}" font-size="14" font-weight="600">${title}</text>
  ${sub ? `<text x="${x + 12}" y="${y + 40}" fill="${C.tx2}" font-size="11">${sub}</text>` : ''}`;
}
function pin(x, y, name, anchor = 'start', dx = 8) {
  const tx = anchor === 'start' ? x + dx : x - dx;
  return `<circle cx="${x}" cy="${y}" r="3.5" fill="#0f1114" stroke="${C.tx2}" stroke-width="1.3"/>
  <text x="${tx}" y="${y + 4}" fill="${C.tx2}" font-size="11" text-anchor="${anchor}">${name}</text>`;
}
const wire = (pts, col, w = 2.2, dash = '') => `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
const jn = (x, y, col) => `<circle cx="${x}" cy="${y}" r="4.5" fill="${col}"/>`;
const tag = (x, y, t, col, anchor = 'start') => `<text x="${x}" y="${y}" fill="${col}" font-size="11" font-weight="600" text-anchor="${anchor}">${t}</text>`;

export function hardwareSVG() {
  const servos = [['SERVO 1 · BASE', 'D3', 190, 300], ['SERVO 2 · SHOULDER', 'D5', 290, 350], ['SERVO 3 · ELBOW', 'D6', 390, 400], ['SERVO 4 · GRIPPER', 'D9', 490, 450]];
  let s = `<svg viewBox="0 0 1200 700" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Mono, monospace">`;
  // ---- blocks
  s += blk(40, 40, 180, 100, '2S BATTERY PACK', '7.4 V nominal · 8.4 V full', '#7c4a14');
  s += blk(340, 40, 200, 100, '5 V REGULATOR', 'buck / UBEC · ≥ 3 A', '#5b2626');
  s += blk(360, 230, 240, 330, 'ARDUINO UNO', 'ATmega328P · PlatformIO C++', '#155e75');
  s += blk(40, 330, 190, 190, 'TCS34725', 'RGB colour sensor · I²C 0x29', '#4c1d95');
  // ---- battery & regulator
  s += pin(220, 100, '+', 'end') + pin(220, 125, '−', 'end');
  s += pin(340, 100, 'IN+') + pin(340, 125, 'IN−') + pin(540, 100, 'OUT+', 'end') + pin(540, 125, 'OUT−', 'end');
  s += wire([[220, 100], [340, 100]], C.raw, 3.2);
  s += tag(236, 92, '7.4 V RAW', C.raw);
  s += wire([[290, 100], [290, 200], [400, 200], [400, 230]], C.raw, 3.2) + jn(290, 100, C.raw);
  s += tag(298, 192, 'VIN 7–12 V', C.raw);
  s += wire([[220, 125], [340, 125]], C.gnd, 2.4);
  // ---- rails
  s += wire([[540, 100], [1120, 100], [1120, 620]], C.v5, 3.4);
  s += tag(700, 92, 'SERVO +5 V RAIL (REGULATED)', C.v5);
  s += wire([[540, 125], [1080, 125], [1080, 620]], C.gnd, 3);
  s += tag(700, 142, 'COMMON GND', C.gnd);
  // capacitor between rails
  s += wire([[1080, 640], [1094, 640]], C.gnd, 2) + wire([[1106, 640], [1120, 640]], C.v5, 2);
  s += `<line x1="1094" y1="628" x2="1094" y2="652" stroke="${C.tx}" stroke-width="2.5"/><path d="M1106 628 Q1100 640 1106 652" fill="none" stroke="${C.tx}" stroke-width="2.5"/>`;
  s += wire([[1080, 620], [1080, 640]], C.gnd, 2) + wire([[1120, 620], [1120, 640]], C.v5, 2);
  s += tag(1100, 676, '470–1000 µF', C.tx2, 'middle');
  // ---- Arduino pins
  s += pin(400, 230, 'VIN', 'start', 8).replace(`y="234"`, `y="222"`);
  s += pin(580, 230, 'GND', 'end', 8).replace(`y="234"`, `y="222"`);
  s += wire([[580, 230], [580, 125]], C.gnd, 2.4) + jn(580, 125, C.gnd);
  const leftPins = [['5V', 400, C.v5], ['GND', 430, C.gnd], ['A4 · SDA', 460, C.sda], ['A5 · SCL', 490, C.scl]];
  const sensPins = ['VIN', 'GND', 'SDA', 'SCL'];
  leftPins.forEach(([n, y, col], i) => {
    s += wire([[230, y], [360, y]], col, 2.4);
    s += pin(360, y, n) + pin(230, y, sensPins[i], 'end');
  });
  servos.forEach(([name, d, sy, py]) => {
    s += pin(600, py, `${d} PWM`, 'end');
  });
  // ---- servos
  servos.forEach(([name, d, sy, py], i) => {
    const lane = 700 + i * 12, sigY = sy + 30;
    s += blk(820, sy, 170, 60, name, 'SG90 · 4.8–6 V', '#1e40af');
    s += wire([[600, py], [lane, py], [lane, sigY], [820, sigY]], C.sig, 2.2);
    s += pin(820, sigY, '');
    s += wire([[990, sy + 18], [1120, sy + 18]], C.v5, 2.2) + jn(1120, sy + 18, C.v5);
    s += wire([[990, sy + 42], [1080, sy + 42]], C.gnd, 2.2) + jn(1080, sy + 42, C.gnd);
    s += `<text x="996" y="${sy + 14}" fill="${C.v5}" font-size="10">+5V</text><text x="996" y="${sy + 56}" fill="${C.gnd}" font-size="10">GND</text>`;
  });
  // ---- legend
  const L = [['Raw battery 7.4 V', C.raw], ['Regulated 5 V', C.v5], ['Ground (common)', C.gnd], ['Servo PWM signal', C.sig], ['I²C SDA', C.sda], ['I²C SCL', C.scl]];
  s += `<text x="40" y="575" fill="${C.tx2}" font-size="11" font-weight="600">LEGEND</text>`;
  L.forEach(([t, col], i) => {
    const x = 40 + (i % 2) * 170, y = 600 + Math.floor(i / 2) * 24;
    s += `<line x1="${x}" y1="${y}" x2="${x + 30}" y2="${y}" stroke="${col}" stroke-width="3"/><text x="${x + 38}" y="${y + 4}" fill="${C.tx}" font-size="11">${t}</text>`;
  });
  s += `<rect x="380" y="590" width="460" height="74" rx="5" fill="#1f1708" stroke="#6b4a12"/>
  <text x="394" y="612" fill="#fde68a" font-size="11.5" font-weight="600">RULE: raw 2S never connects to the servo rail.</text>
  <text x="394" y="632" fill="#e7d9a8" font-size="11">Battery → regulator → +5 V rail → servos.</text>
  <text x="394" y="650" fill="#e7d9a8" font-size="11">Battery → UNO VIN only (on-board regulator makes 5 V logic).</text>`;
  s += `</svg>`;
  return s;
}
