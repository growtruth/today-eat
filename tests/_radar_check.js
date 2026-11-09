const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG = 9452, PORT = 5000;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'eat-radar-check2');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--window-size=492,932',
    `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch (e) { /* wait */ }
    await sleep(250);
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const n = id++;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params: params || {}, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/?nogeo=1` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await sleep(2200);

  const probe = await send('Runtime.evaluate', {
    expression: `(() => ({
      hasRadar: typeof Radar,
      hasFeed: typeof Feed,
      filtered: window.Feed ? Feed.filtered.length : -1,
      cards: document.querySelectorAll('.card').length,
      entry: !!document.getElementById('radarBtn')
    }))()`,
    returnByValue: true
  }, sessionId);
  console.log('probe:', JSON.stringify(probe.result));

  const flow = await send('Runtime.evaluate', {
    expression: `(async () => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const t = (sel) => (document.querySelector(sel) || {}).textContent || '';
      const out = {};
      document.getElementById('radarBtn').click();
      await s(800);
      out.open = document.getElementById('radarLayer').classList.contains('is-open');
      out.blips = document.querySelectorAll('.radar-blip').length;
      out.rings = document.querySelectorAll('.radar-ring-label').length;
      out.sub = t('#radarSub');
      out.ringText = t('#radarRings');
      const first = document.querySelector('.radar-blip');
      out.hasFirst = !!first;
      if (first) { first.dispatchEvent(new MouseEvent('click', { bubbles: true })); await s(350); }
      out.cardName = t('#radarCardName');
      out.meta = t('#radarMeta');
      out.kicker = t('#radarKicker');
      out.selected = document.querySelectorAll('.radar-blip.is-selected').length;
      document.getElementById('radarScan').click();
      await s(1200);
      out.picked = document.querySelectorAll('.radar-blip.is-picked').length;
      out.pickedKicker = t('#radarKicker');
      out.pickedName = t('#radarCardName');
      return out;
    })()`,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  console.log('exception:', JSON.stringify(flow.exceptionDetails || null).slice(0, 600));
  console.log('flow:', JSON.stringify(flow.result));

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(__dirname, 'shots-radar.png'), Buffer.from(shot.data, 'base64'));
  ws.close();
  browser.kill();
})();
