#!/usr/bin/env node
/**
 * Drives a real (non-virtual-time) headless Chrome over the DevTools
 * protocol and reports what the page's HUD actually shows.
 *
 *   node tools/browser-check.js http://localhost:3001
 */
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'http://localhost:3001';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/opencode-chrome-profile',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('chrome devtools never came up');
}

(async () => {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  await new Promise((r) => ws.addEventListener('open', r));

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ });

  await sleep(4000);

  const out = await evaluate(`JSON.stringify({
    hz:        document.getElementById('s-hz').textContent,
    fps:       document.getElementById('s-fps').textContent,
    lat:       document.getElementById('s-lat').textContent,
    err:       document.getElementById('s-err').textContent,
    status:    document.getElementById('s-status').textContent,
    pitch:     document.getElementById('v-pitch').textContent,
    roll:      document.getElementById('v-roll').textContent,
    yaw:       document.getElementById('v-yaw').textContent,
    now:       performance.now(),
    hzVar:     (typeof hz !== 'undefined') ? hz : 'undef',
    fpsVar:    (typeof fps !== 'undefined') ? fps : 'undef',
    frames:    (typeof frameCount !== 'undefined') ? frameCount : 'undef',
    rateStart: (typeof rateWindowStart !== 'undefined') ? rateWindowStart : 'undef'
  })`);

  console.log('\n  ===== BROWSER HUD =====');
  const v = JSON.parse(out);
  for (const k of Object.keys(v)) {
    console.log(`  ${k.padEnd(10)} ${v[k]}`);
  }

  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  chrome.kill();
  process.exit(1);
});
