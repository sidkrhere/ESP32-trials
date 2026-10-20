#!/usr/bin/env node
/**
 * End-to-end integration test.
 *
 *   ESP32-C3 (real hardware, or a simulated pty with --fake)
 *     -> server.js  ->  socket.io  ->  this client
 *
 * Verifies the binary framing, the stream rate, the latency accounting
 * and the recalibration command.
 *
 *   node tools/integration-test.js          # real ESP32
 *   node tools/integration-test.js --fake   # simulated ESP32 on a pty
 */
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 3111;
const USE_FAKE = process.argv.includes('--fake');
const ESP_PORT = '/dev/cu.usbmodem1101';

let fake = null;
let ptyPath = null;
let server = null;

function startServer(env) {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return server;
}

function attach(server, tag = 'server') {
  server.stdout.on('data', (d) => process.stdout.write(`  [${tag}] ${d.toString()}`));
  server.stderr.on('data', (d) => process.stdout.write(`  [${tag}!] ${d.toString()}`));
  return server;
}

const results = { frames: 0, latency: [], pitch: [], roll: [], seqs: new Set() };
let status = null;
let serverOut = '';

function check(name, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  return cond;
}

function finish(code) {
  if (fake) try { fake.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
  process.exit(code);
}

function runClient() {
  const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });

  socket.on('status', (s) => {
    status = s;
    console.log('  [status]', JSON.stringify(s));
  });

  socket.on('pose', (data) => {
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer || data);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    results.frames++;
    results.seqs.add(dv.getUint8(0));
    results.pitch.push(dv.getFloat32(2, true));
    results.roll.push(dv.getFloat32(6, true));
    const tNode = dv.getFloat64(14, true);
    results.latency.push(performance.now() - tNode);
  });

  socket.on('connect', () => console.log('  [client] connected'));

  setTimeout(() => {
    console.log('\n  ===== RESULTS =====');
    let ok = true;

    ok &= check('frames received', results.frames > 200, `${results.frames} frames`);
    ok &= check('unique sequence numbers', results.seqs.size > 150, `${results.seqs.size} unique`);

    const hz = results.frames / 4;
    ok &= check('stream rate >= 80 Hz', hz >= 80, `${hz.toFixed(1)} Hz`);

    const minD = Math.min(...results.latency);
    const rel = results.latency.map((d) => d - minD);
    const avg = rel.reduce((a, b) => a + b, 0) / rel.length;
    const max = Math.max(...rel);
    ok &= check('latency under 20 ms', avg < 20, `avg ${avg.toFixed(2)} ms, max ${max.toFixed(2)} ms`);

    ok &= check(
      'status reported connected',
      status && status.state === 'connected',
      status ? status.state : 'none'
    );

    socket.emit('recalibrate');
    setTimeout(() => {
      ok &= check('recalibrate command forwarded', /recalibration requested/.test(serverOut));
      console.log(ok ? '\n  ALL CHECKS PASSED\n' : '\n  SOME CHECKS FAILED\n');
      finish(ok ? 0 : 1);
    }, 700);
  }, 4000);
}

if (USE_FAKE) {
  console.log('  [test] using simulated ESP32 on a pty');
  fake = spawn('python3', [path.join(__dirname, 'fake-esp32.py')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  fake.stdout.on('data', (d) => {
    const s = d.toString().trim();
    if (s && s.startsWith('/') && !ptyPath) {
      ptyPath = s;
      console.log('  [fake ] pty =', ptyPath);
      const srv = attach(startServer({ ESP32_PORT: ptyPath }));
      srv.stdout.on('data', (d) => (serverOut += d.toString()));
      setTimeout(runClient, 1200);
    }
  });
} else {
  console.log('  [test] using real ESP32 at', ESP_PORT);
  const srv = attach(startServer());
  srv.stdout.on('data', (d) => (serverOut += d.toString()));
  setTimeout(runClient, 1500);
}

setTimeout(() => {
  console.error('\n  TIMEOUT');
  finish(1);
}, 30000);
