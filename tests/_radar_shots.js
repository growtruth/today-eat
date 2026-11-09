const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG = 9453, PORT = 5000;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'eat-radar-shots');
const OUT = path.join(__dirname, '..', 'tests', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
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

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  const load = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: true
    }, sessionId);
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?nogeo=1` }, sessionId);
    await sleep(2600);
  };
  const capture = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
  };
  const measure = async () => {
    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const chips = document.getElementById('condChips');
        const row = document.getElementById('filterRow');
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          chipsClient: chips.clientWidth,
          chipsScroll: chips.scrollWidth,
          filterClient: row.clientWidth,
          filterScroll: row.scrollWidth,
          radarEntryWidth: Math.round(document.getElementById('radarBtn').getBoundingClientRect().width),
          countWidth: Math.round(document.getElementById('condCount').getBoundingClientRect().width)
        };
      })()`,
      returnByValue: true
    }, sessionId);
    return res.result.value;
  };

  await load(492, 932);
  await capture('radar-home-492.png');
  console.log('492:', JSON.stringify(await measure()));
  await send('Runtime.evaluate', { expression: `document.getElementById('radarBtn').click()` }, sessionId);
  await sleep(900);
  await capture('radar-492.png');

  await load(375, 812);
  await capture('radar-home-375.png');
  console.log('375:', JSON.stringify(await measure()));
  await send('Runtime.evaluate', { expression: `document.getElementById('radarBtn').click()` }, sessionId);
  await sleep(900);
  await capture('radar-375.png');

  ws.close();
  browser.kill();
})();
