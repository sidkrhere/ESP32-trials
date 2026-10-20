#!/usr/bin/env node
/**
 * Standalone firmware check: opens the USB serial port, parses the binary
 * frames the ESP32 emits and reports the stream rate, CRC health and
 * pose values.
 *
 *   node tools/firmware-check.js            # also triggers a recalibration
 *   node tools/firmware-check.js --no-recal
 */
const fs = require('fs');

const FRAME_SIZE = 17;
const PORT = process.argv[3] || '/dev/cu.usbmodem1101';
const DURATION_MS = 8000;

function crc8(buf, len) {
  let c = 0;
  for (let i = 0; i < len; i++) {
    c ^= buf[i];
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

const fd = fs.openSync(PORT, 'r+');
const stream = fs.createReadStream(null, { fd, autoClose: false, highWaterMark: 4096 });

let buf = Buffer.alloc(0);
let frames = 0;
let bad = 0;
let first = null;
let last = null;
const t0 = Date.now();

stream.on('data', (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  while (buf.length >= 2) {
    let i = buf.indexOf(0xa5);
    if (i < 0) {
      buf = buf.subarray(Math.max(0, buf.length - 1));
      return;
    }
    if (i > 0) buf = buf.subarray(i);
    if (buf.length < 2) return;
    const kind = buf[1];
    if (kind === 0x5a) {
      if (buf.length < FRAME_SIZE) return;
      const f = buf.subarray(0, FRAME_SIZE);
      if (crc8(f, 16) !== f[16]) {
        bad++;
        buf = buf.subarray(1);
        continue;
      }
      const p = {
        pitch: f.readFloatLE(4),
        roll: f.readFloatLE(8),
        yaw: f.readFloatLE(12),
        flags: f[3],
      };
      if (!first) first = p;
      last = p;
      frames++;
      buf = buf.subarray(FRAME_SIZE);
    } else if (kind === 0x5b) {
      const nl = buf.indexOf(0x0a, 2);
      if (nl < 0) return;
      console.log('[esp]', buf.subarray(2, nl).toString('utf8'));
      buf = buf.subarray(nl + 1);
    } else {
      buf = buf.subarray(1);
    }
  }
});

stream.on('error', (e) => console.error('ERR', e.message));

setTimeout(() => {
  const secs = (Date.now() - t0) / 1000;
  console.log('\n--- summary ---');
  console.log('frames      :', frames, 'in', secs.toFixed(1), 's');
  console.log('rate        :', (frames / secs).toFixed(1), 'Hz');
  console.log('crc errors  :', bad);
  console.log('first frame :', JSON.stringify(first));
  console.log('last frame  :', JSON.stringify(last));
  if (last) {
    console.log('sensor ok   :', (last.flags & 1) ? 'YES' : 'NO');
    console.log('i2c errors  :', (last.flags >> 2) & 0x3f);
  }
  stream.destroy();
  try { fs.closeSync(fd); } catch (e) {}
  process.exit(0);
}, DURATION_MS);

if (!process.argv.includes('--no-recal')) {
  setTimeout(() => {
    console.log('--- sending recalibrate (C) ---');
    try { fs.writeSync(fd, 'C'); } catch (e) { console.error('write ERR', e.message); }
  }, 6000);
}
