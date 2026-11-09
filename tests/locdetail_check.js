/* 临时验证：定位详情（坐标 / POI 地址 / 地图 / 地标 / 推荐） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 5010);
const DEBUG_PORT = Number(process.argv[3] || 9340);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(process.env.TEMP || '/tmp', 'eat-locdetail');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1; const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); });
  return { ws, send, ready };
}
async function waitForVersion() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); if (r.ok) return r.json(); } catch (e) {} await sleep(250); }
  throw new Error('调试端口未就绪');
}
async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--force-device-scale-factor=1', '--window-size=492,932', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
  try {
    const version = await waitForVersion();
    const client = connect(version.webSocketDebuggerUrl); await client.ready;
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Runtime.enable', {}, sessionId); await client.send('Page.enable', {}, sessionId);
    const logs = [];
    client.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.args) {
        logs.push(m.params.args.map((a) => (a.value != null ? String(a.value) : (a.description || ''))).join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails || {}).slice(0, 300));
    });
    // mock GPS：望京（WGS-84）
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){ try {
        Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: function(s){ s({ coords: { latitude: 39.9963, longitude: 116.4703, accuracy: 25 } }); } }, configurable: true });
      } catch(e){} })();`
    }, sessionId);
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await sleep(4500);
    const evalJs = (expression) => client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const out = {};

    // 打开定位弹层 → 查看定位详情
    await evalJs(`document.getElementById('locBtn').click()`);
    await sleep(600);
    out.hasDetailEntry = await evalJs(`!!document.querySelector('.loc-detail-link')`);
    await evalJs(`document.querySelector('.loc-detail-link').click()`);
    await sleep(5000);

    out.detail = (await evalJs(`(() => ({
      open: document.getElementById('locLayer').classList.contains('is-open'),
      lng: (document.getElementById('locLng')||{}).textContent,
      lat: (document.getElementById('locLat')||{}).textContent,
      accuracy: (document.getElementById('locAccuracy')||{}).textContent,
      source: (document.getElementById('locSource')||{}).textContent,
      raw: (document.getElementById('locRaw')||{}).textContent,
      addrPrecise: (document.getElementById('locAddrPrecise')||{}).textContent,
      addrFull: (document.getElementById('locAddrFull')||{}).textContent,
      tags: document.querySelectorAll('#locAddrTags .loc-tag').length,
      landmarks: document.querySelectorAll('#locLandmarks .loc-lm').length,
      landmarkCount: (document.getElementById('locLandmarkCount')||{}).textContent,
      areaType: (document.getElementById('locAreaType')||{}).textContent,
      insight: (document.getElementById('locInsight')||{}).textContent,
      rule: (document.getElementById('locRule')||{}).textContent,
      picks: document.querySelectorAll('#locPicks .loc-pick').length,
      mapChildren: (document.getElementById('locMap')||{}).children.length,
      mapHasSvg: !!document.querySelector('#locMap svg'),
      mapHasAmap: !!document.querySelector('#locMap .amap-container'),
      tabHidden: document.getElementById('tabbar').classList.contains('is-hidden')
    }))()`)).result.value;

    // 缩放交互
    await evalJs(`document.getElementById('locZoomIn').click()`);
    await sleep(400);
    out.zoomAfterIn = (await evalJs(`(document.querySelector('#locMap svg')||{}).style.transform || ''`)).result.value;
    await evalJs(`document.getElementById('locZoomOut').click()`);
    await sleep(400);
    out.zoomAfterOut = (await evalJs(`(document.querySelector('#locMap svg')||{}).style.transform || ''`)).result.value;

    // 点击地图标记 / 地标列表 → 详情弹层
    await evalJs(`(() => { const n = document.querySelector('#locLandmarks .loc-lm'); if (n) n.click(); return !!n; })()`);
    await sleep(700);
    out.landmarkSheet = (await evalJs(`(() => ({
      title: (document.querySelector('.sheet-title')||{}).textContent || '',
      text: (document.getElementById('sheetRoot')||{}).textContent || ''
    }))()`)).result.value;
    await evalJs(`document.querySelector('.sheet-mask') && document.querySelector('.sheet-mask').click()`);
    await sleep(500);

    // 返回键关闭浮层
    const beforeBack = (await evalJs(`document.getElementById('locLayer').classList.contains('is-open')`)).result.value;
    await evalJs(`history.back()`);
    await sleep(800);
    const afterBack = (await evalJs(`document.getElementById('locLayer').classList.contains('is-open')`)).result.value;
    out.backCloses = { before: beforeBack, after: afterBack };

    out.logs = logs.slice(0, 8);
    console.log(JSON.stringify(out, null, 2));
    client.ws.close();
  } finally { browser.kill(); }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
