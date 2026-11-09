/* 临时验证：首次进入不预设地址，真实定位后再加载 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 5010);
const DEBUG_PORT = Number(process.argv[3] || 9339);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(process.env.TEMP || '/tmp', 'eat-nopreset');
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
    // 注入 mock：GPS 成功返回深圳坐标（验证"任意城市都能用"）
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Runtime.enable', {}, sessionId); await client.send('Page.enable', {}, sessionId);
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){ window.__geoCall = 0; try {
        Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: function(s){ window.__geoCall=(window.__geoCall||0)+1; setTimeout(function(){ s({ coords: { latitude: 22.5431, longitude: 114.0579, accuracy: 20 } }); }, 2500); } }, configurable: true });
      } catch(e){ window.__mockErr = String(e); }
        document.addEventListener('DOMContentLoaded', function(){
          setTimeout(function(){ window.__feedEarly = (document.getElementById('feedStatus')||{}).innerHTML || ''; }, 0);
          setTimeout(function(){ window.__feedMid = (document.getElementById('feedStatus')||{}).innerHTML || ''; }, 100);
        });
      })();`
    }, sessionId);
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await sleep(1200);
    const evalJs = (expression) => client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const out = {};

    // 1. 定位前：应显示"正在获取位置"，且 App.state.location 为 null（不预设）
    const before = await evalJs(`(() => {
      const r = {
        locIsNull: (window.App.state.location === null),
        feedHtml: (document.getElementById('feedStatus')||{}).innerHTML || '',
        feedEarly: window.__feedEarly || '',
        feedMid: window.__feedMid || '',
        cards: document.querySelectorAll('.card').length
      };
      // 手动触发一次 render，看 renderLocating 是否执行
      try { window.Feed.render(); r.afterManualRender = (document.getElementById('feedStatus')||{}).innerHTML || ''; } catch(e) { r.renderErr = String(e); }
      return r;
    })()`);
    out.beforeLocate = before.result.value;

    // 等待定位成功 + 数据加载（定位延迟 2.5s + 数据请求）
    await sleep(6000);
    const after = await evalJs(`(() => ({
      geoCall: window.__geoCall || 0,
      label: (document.getElementById('locLabel')||{}).textContent || '',
      lat: (window.App.state.location || {}).lat,
      lng: (window.App.state.location || {}).lng,
      cards: document.querySelectorAll('.card').length,
      source: (window.App.state.sourceInfo && window.App.state.sourceInfo.source) || ''
    }))()`);
    out.afterLocate = after.result.value;

    console.log(JSON.stringify(out, null, 2));
    client.ws.close();
  } finally { browser.kill(); }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
