'use strict';
/**
 * ESP32-C3 Super Mini  ->  MPU6050  ->  browser 3D viewer
 *
 *  ESP32 --(USB CDC, binary 17-byte frames @100 Hz)--> this server
 *  this server --(Socket.IO binary)--> browser (Three.js)
 *
 *  End-to-end latency is measured by stamping every frame with this
 *  process's performance.now() and letting the browser subtract a
 *  running-minimum clock offset.
 *
 *  Usage:  npm start        (then open http://localhost:3000)
 *
 *  IMPORTANT: the Arduino IDE Serial Monitor grabs the USB serial port
 *  exclusively. Close it before starting this server.
 *
 *  The port is read with plain fs.createReadStream rather than the
 *  `serialport` npm package: on macOS the native binding only delivered
 *  ~30 Hz of a 100 Hz stream, while a plain file-descriptor read gets
 *  the full rate (and needs no native build).
 */

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// ---------------------------------------------------------------- config
const PORT = process.env.PORT || 3000;
const KNOWN_PORT = '/dev/cu.usbmodem1101';
const FRAME_SIZE = 17;
const LOG_MAGIC = 0xa5;
const DATA_MAGIC = 0x5a;
const LOG_MAGIC2 = 0x5b;

// ------------------------------------------------------------------ app
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public')));
// serve three.js locally - no CDN, no network dependency at runtime
app.use(
  '/vendor/three',
  express.static(path.join(__dirname, 'node_modules', 'three', 'build'))
);
app.use(
  '/vendor/three/addons',
  express.static(path.join(__dirname, 'node_modules', 'three', 'examples', 'jsm'))
);

// --------------------------------------------------------------- CRC-8
function crc8(buf, len) {
  let c = 0;
  for (let i = 0; i < len; i++) {
    c ^= buf[i];
    for (let b = 0; b < 8; b++) {
      c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
  }
  return c;
}

// ------------------------------------------------------- device finding
function findPort() {
  // 0. explicit override (used by the integration test)
  if (process.env.ESP32_PORT) return process.env.ESP32_PORT;

  // 1. the path we already know about.  Prefer the callout device
  //    (/dev/cu.* has no terminal flow control).
  const known = [KNOWN_PORT, KNOWN_PORT.replace('/dev/cu.', '/dev/tty.')];
  for (const p of known) {
    if (fs.existsSync(p)) return p;
  }

  // 2. scan for any usbmodem device
  try {
    const hits = fs
      .readdirSync('/dev')
      .filter((f) => /^(cu|tty)\.usbmodem/i.test(f))
      .sort((a, b) => (a.startsWith('cu.') ? -1 : 1));
    if (hits.length) return '/dev/' + hits[0];
  } catch (e) {
    /* ignore */
  }
  return null;
}

// ------------------------------------------------------- serial plumbing
let fd = null;
let stream = null;
let connected = false;
let reconnectTimer = null;
let buf = Buffer.alloc(0);
let lastStatus = { state: 'starting', detail: '' };

function setStatus(state, detail) {
  lastStatus = { state, detail: detail || '' };
  io.emit('status', lastStatus);
}

function closeLink() {
  if (stream) {
    stream.removeAllListeners();
    stream.destroy();
    stream = null;
  }
  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* ignore */
    }
    fd = null;
  }
}

function connect() {
  const dev = findPort();
  if (!dev) {
    setStatus('waiting', 'no ESP32 found - plug it in');
    scheduleReconnect();
    return;
  }

  closeLink();
  buf = Buffer.alloc(0);

  try {
    fd = fs.openSync(dev, 'r+');
  } catch (err) {
    const busy = /busy/i.test(err.message);
    console.error(
      busy
        ? `[serial] ${dev} is BUSY - close the Arduino IDE Serial Monitor and retry`
        : `[serial] ${err.message}`
    );
    setStatus('error', err.message);
    scheduleReconnect();
    return;
  }

  stream = fs.createReadStream(null, {
    fd,
    autoClose: false,
    highWaterMark: 4096,
  });

  stream.on('data', (chunk) => onData(chunk));

  stream.on('error', (err) => {
    console.error(`[serial] ${err.message}`);
    setStatus('error', err.message);
  });

  stream.on('close', () => {
    if (connected) {
      connected = false;
      console.log('[serial] disconnected');
      setStatus('disconnected', dev);
    }
    closeLink();
    scheduleReconnect();
  });

  connected = true;
  console.log(`[serial] connected to ${dev}`);
  setStatus('connected', dev);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}

// ------------------------------------------------------ frame demuxing
function onData(chunk) {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

  while (buf.length >= 2) {
    // hunt for the sync byte
    let i = buf.indexOf(LOG_MAGIC);
    if (i < 0) {
      buf = buf.subarray(Math.max(0, buf.length - 1));
      return;
    }
    if (i > 0) buf = buf.subarray(i);
    if (buf.length < 2) return;

    const kind = buf[1];

    if (kind === DATA_MAGIC) {
      if (buf.length < FRAME_SIZE) return;
      const f = buf.subarray(0, FRAME_SIZE);
      if (crc8(f, 16) === f[16]) {
        onPose(f);
      } else {
        // corrupt frame - drop one byte and resync
        buf = buf.subarray(1);
        continue;
      }
      buf = buf.subarray(FRAME_SIZE);
    } else if (kind === LOG_MAGIC2) {
      const nl = buf.indexOf(0x0a, 2);
      if (nl < 0) return;
      console.log('[esp]', buf.subarray(2, nl).toString('utf8'));
      buf = buf.subarray(nl + 1);
    } else {
      buf = buf.subarray(1);
    }
  }
}

// ------------------------------------------------------------ pose relay
function onPose(f) {
  const seq = f[2];
  const flags = f[3];
  const pitch = f.readFloatLE(4);
  const roll = f.readFloatLE(8);
  const yaw = f.readFloatLE(12);
  const tNode = performance.now();

  const out = Buffer.alloc(22);
  out[0] = seq;
  out[1] = flags;
  out.writeFloatLE(pitch, 2);
  out.writeFloatLE(roll, 6);
  out.writeFloatLE(yaw, 10);
  out.writeDoubleLE(tNode, 14);

  // volatile: drop frames for a slow client instead of queueing them
  io.volatile.emit('pose', out);
}

/* -------------------------------------------------- host -> device cmd */
// 'C' makes the ESP32 redo its startup calibration (level the rectangle
// against however the sensor is being held right now).
io.on('connection', (sock) => {
  // tell the new client what the current link state is
  sock.emit('status', lastStatus);

  sock.on('recalibrate', () => {
    if (fd !== null) {
      try {
        fs.writeSync(fd, 'C');
        console.log('[serial] recalibration requested');
      } catch (e) {
        console.error(`[serial] write failed: ${e.message}`);
      }
    } else {
      console.log('[serial] not connected - cannot recalibrate');
    }
  });
});

// ---------------------------------------------------------------- start
server.listen(PORT, () => {
  console.log(`\n  ESP32-C3 3D viewer backend`);
  console.log(`  ----------------------------------------------`);
  console.log(`  Open  http://localhost:${PORT}\n`);
  connect();
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down');
  closeLink();
  process.exit(0);
});
