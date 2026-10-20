import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const socket = io();

/* ================================================================== *
 *  Settings (persisted)
 * ================================================================== */
const SETTINGS_KEY = 'esp32-3d-viewer-settings';
const settings = Object.assign(
  {
    smoothMs: 25,
    invertPitch: false,
    invertRoll: false,
    applyYaw: false,
  },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
);

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/* ================================================================== *
 *  Scene
 * ================================================================== */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1016);
scene.fog = new THREE.Fog(0x0e1016, 16, 34);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(4.2, 3.2, 6.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

/* ------------------------------------------------------------ lighting */
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

const key = new THREE.DirectionalLight(0xffffff, 1.35);
key.position.set(5, 8, 6);
scene.add(key);

const rim = new THREE.DirectionalLight(0x35e0d8, 0.55);
rim.position.set(-6, -1, -5);
scene.add(rim);

/* ---------------------------------------------------------- reference */
const grid = new THREE.GridHelper(14, 28, 0x2c3d55, 0x18212f);
grid.position.y = -1.7;
scene.add(grid);

const axes = new THREE.AxesHelper(1.1);
axes.position.y = -1.69;
scene.add(axes);

/* ================================================================== *
 *  The rectangle
 *  Lies flat in the XZ plane so that:
 *    rotation.x  ->  pitches it forward / backward
 *    rotation.z  ->  rolls it left / right
 * ================================================================== */
const RECT_W = 3.6;
const RECT_D = 2.4;

const rectGroup = new THREE.Group();

const plate = new THREE.Mesh(
  new THREE.PlaneGeometry(RECT_W, RECT_D),
  new THREE.MeshStandardMaterial({
    color: 0x1d9bd1,
    side: THREE.DoubleSide,
    roughness: 0.34,
    metalness: 0.12,
    transparent: true,
    opacity: 0.7,
  })
);
plate.rotation.x = -Math.PI / 2; // lie flat
rectGroup.add(plate);

const outline = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-RECT_W / 2, 0, -RECT_D / 2),
    new THREE.Vector3(RECT_W / 2, 0, -RECT_D / 2),
    new THREE.Vector3(RECT_W / 2, 0, RECT_D / 2),
    new THREE.Vector3(-RECT_W / 2, 0, RECT_D / 2),
  ]),
  new THREE.LineBasicMaterial({ color: 0x35e0d8 })
);
rectGroup.add(outline);

// corner ticks, so rotation is easy to read at a glance
const tickMat = new THREE.LineBasicMaterial({ color: 0xffb347 });
const ticks = new THREE.Group();
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3((sx * RECT_W) / 2, 0.001, (sz * RECT_D) / 2),
      new THREE.Vector3((sx * RECT_W) / 2 - sx * 0.42, 0.001, (sz * RECT_D) / 2),
    ]);
    const l1 = new THREE.Line(g, tickMat);
    const g2 = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3((sx * RECT_W) / 2, 0.001, (sz * RECT_D) / 2),
      new THREE.Vector3((sx * RECT_W) / 2, 0.001, (sz * RECT_D) / 2 - sz * 0.42),
    ]);
    const l2 = new THREE.Line(g2, tickMat);
    ticks.add(l1, l2);
  }
}
rectGroup.add(ticks);

scene.add(rectGroup);

/* ================================================================== *
 *  State
 * ================================================================== */
let lastPitch = 0;
let lastRoll = 0;
let lastYaw = 0;
let haveData = false;

const euler = new THREE.Euler(0, 0, 0, 'XYZ');
const targetQuat = new THREE.Quaternion();
const renderQuat = new THREE.Quaternion();

let minDelta = Infinity; // running minimum of (browserNow - nodeNow)
let latencyMs = 0;

let frameCount = 0;
let hz = 0;
let rateWindowStart = performance.now();

let fpsFrames = 0;
let fps = 0;
let fpsWindowStart = performance.now();

let lastFrameMs = performance.now();

function updateTarget() {
  const pitchOut = settings.invertPitch ? -lastPitch : lastPitch;
  const rollOut = settings.invertRoll ? lastRoll : -lastRoll;
  const yawOut = settings.applyYaw ? lastYaw : 0;

  euler.set(
    THREE.MathUtils.degToRad(pitchOut),
    THREE.MathUtils.degToRad(yawOut),
    THREE.MathUtils.degToRad(rollOut),
    'XYZ'
  );
  targetQuat.setFromEuler(euler);
}

/* ================================================================== *
 *  Socket
 * ================================================================== */
socket.on('connect', () => {
  setStatus('good', 'socket connected');
});

socket.on('disconnect', () => {
  setStatus('bad', 'socket disconnected');
});

socket.on('status', (s) => {
  const label = s.state.toUpperCase();
  const cls = s.state === 'connected' ? 'good' : s.state === 'error' ? 'bad' : 'warn';
  setStatus(cls, label);
  if (s.detail) {
    document.getElementById('s-port').textContent = s.detail;
  }
});

socket.on('pose', (data) => {
  let dv;
  if (data instanceof ArrayBuffer) {
    dv = new DataView(data);
  } else if (ArrayBuffer.isView(data)) {
    dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return;
  }

  lastPitch = dv.getFloat32(2, true);
  lastRoll = dv.getFloat32(6, true);
  lastYaw = dv.getFloat32(10, true);
  const tNode = dv.getFloat64(14, true);

  // true end-to-end latency: the running minimum absorbs the constant
  // offset between node's clock epoch and the browser's clock epoch
  const now = performance.now();
  const delta = now - tNode;
  if (delta < minDelta) minDelta = delta;
  latencyMs = Math.max(0, delta - minDelta);

  frameCount++;
  const el = now - rateWindowStart;
  if (el >= 500) {
    hz = (frameCount * 1000) / el;
    frameCount = 0;
    rateWindowStart = now;
  }

  const flags = dv.getUint8(1);
  const valid = flags & 0x01;
  const errs = (flags >> 2) & 0x3f;
  const errEl = document.getElementById('s-err');
  errEl.textContent = String(errs);
  errEl.className = 'v small ' + (errs > 0 ? 'bad' : 'good');

  if (!haveData) {
    haveData = true;
    renderQuat.copy(targetQuat);
  }
  updateTarget();
});

/* ================================================================== *
 *  HUD
 * ================================================================== */
const el = {
  pitch: document.getElementById('v-pitch'),
  roll: document.getElementById('v-roll'),
  yaw: document.getElementById('v-yaw'),
  status: document.getElementById('s-status'),
  hz: document.getElementById('s-hz'),
  fps: document.getElementById('s-fps'),
  lat: document.getElementById('s-lat'),
  err: document.getElementById('s-err'),
  port: document.getElementById('s-port'),
};

function setStatus(cls, text) {
  el.status.textContent = text;
  el.status.className = 'v small ' + cls;
}

function updateHud() {
  el.pitch.textContent = haveData ? lastPitch.toFixed(1) : '--';
  el.roll.textContent = haveData ? lastRoll.toFixed(1) : '--';
  el.yaw.textContent = haveData ? lastYaw.toFixed(1) : '--';

  el.hz.textContent = hz ? hz.toFixed(0) + ' Hz' : '-- Hz';
  el.hz.className = 'v small ' + (hz > 80 ? 'good' : hz > 0 ? 'warn' : 'bad');

  el.fps.textContent = fps ? fps.toFixed(0) + ' fps' : '-- fps';
  el.fps.className = 'v small ' + (fps > 50 ? 'good' : fps > 0 ? 'warn' : 'bad');

  el.lat.textContent = haveData ? latencyMs.toFixed(1) + ' ms' : '-- ms';
  el.lat.className =
    'v small ' + (latencyMs < 20 ? 'good' : latencyMs < 50 ? 'warn' : 'bad');
}

setInterval(updateHud, 200);

/* ================================================================== *
 *  Controls
 * ================================================================== */
const cSmooth = document.getElementById('c-smooth');
const vSmooth = document.getElementById('v-smooth');
const cInvPitch = document.getElementById('c-invpitch');
const cInvRoll = document.getElementById('c-invroll');
const cApplyYaw = document.getElementById('c-applyyaw');

cSmooth.value = settings.smoothMs;
vSmooth.textContent = settings.smoothMs + ' ms';
cInvPitch.checked = settings.invertPitch;
cInvRoll.checked = settings.invertRoll;
cApplyYaw.checked = settings.applyYaw;

cSmooth.addEventListener('input', () => {
  settings.smoothMs = Number(cSmooth.value);
  vSmooth.textContent = settings.smoothMs + ' ms';
  saveSettings();
});

cInvPitch.addEventListener('change', () => {
  settings.invertPitch = cInvPitch.checked;
  saveSettings();
  updateTarget();
});

cInvRoll.addEventListener('change', () => {
  settings.invertRoll = cInvRoll.checked;
  saveSettings();
  updateTarget();
});

cApplyYaw.addEventListener('change', () => {
  settings.applyYaw = cApplyYaw.checked;
  saveSettings();
  updateTarget();
});

document.getElementById('c-reset').addEventListener('click', () => {
  socket.emit('recalibrate');
  setStatus('warn', 'recalibrating…');
});

/* ================================================================== *
 *  Resize + render loop
 * ================================================================== */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrameMs) / 1000);
  lastFrameMs = now;

  if (settings.smoothMs > 0) {
    // frame-rate independent exponential smoothing along the shortest path
    const k = 1 - Math.exp((-dt * 1000) / settings.smoothMs);
    renderQuat.slerp(targetQuat, k);
  } else {
    renderQuat.copy(targetQuat);
  }
  rectGroup.quaternion.copy(renderQuat);

  controls.update();
  renderer.render(scene, camera);

  fpsFrames++;
  const el2 = now - fpsWindowStart;
  if (el2 >= 500) {
    fps = (fpsFrames * 1000) / el2;
    fpsFrames = 0;
    fpsWindowStart = now;
  }
}

updateTarget();
animate();
