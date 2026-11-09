/* 临时验证：半径分页（触底扩半径 / 单次加载 / 去重 / 排序 / 到底） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 5010);
const DEBUG_PORT = Number(process.argv[3] || 9343);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(process.env.TEMP || '/tmp', 'eat-paging');
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
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){ try {
        Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: function(s){ s({ coords: { latitude: 39.9963, longitude: 116.4703, accuracy: 25 } }); } }, configurable: true });
      } catch(e){} })();`
    }, sessionId);
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await sleep(5000);
    const evalJs = (expression) => client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const out = {};

    const snap = () => evalJs(`(() => ({
      cards: document.querySelectorAll('.card').length,
      items: Feed.items.length,
      filtered: Feed.filtered.length,
      visible: Feed.visible,
      radius: App.state.pagination.radius,
      filterDistance: Filters.state.distance,
      fetchedRadius: App.state.fetchedRadius,
      loading: App.state.pagination.loading,
      noMore: App.state.pagination.noMore,
      status: (document.getElementById('feedStatus')||{}).textContent || ''
    }))()`);

    out.initial = (await snap()).result.value;

    // 1) 本地优先：重置渲染进度后 loadMore 应只增 visible、不改半径
    await evalJs(`(() => { Feed.render(); return true; })()`);
    await sleep(300);
    const beforeLocal = (await snap()).result.value;
    await evalJs(`Feed.loadMore()`);
    await sleep(250);
    const afterLocal = (await snap()).result.value;
    out.localFirst = {
      visibleBefore: beforeLocal.visible,
      visibleAfter: afterLocal.visible,
      radiusUnchanged: beforeLocal.radius === afterLocal.radius
    };

    // 2) 串行驱动半径分页：每次等 loading 结束再触发下一档
    out.radiusSteps = [];
    for (let i = 0; i < 4; i++) {
      for (let w = 0; w < 60; w++) {
        const loading = (await evalJs(`App.state.pagination.loading`)).result.value;
        if (!loading) break;
        await sleep(250);
      }
      const before = (await snap()).result.value;
      if (before.noMore) {
        out.radiusSteps.push({ call: i + 1, skipped: 'noMore', radius: before.radius });
        break;
      }
      const ok = (await evalJs(`App.loadMoreByRadius()`)).result.value;
      await sleep(400);
      const after = (await snap()).result.value;
      out.radiusSteps.push({
        call: i + 1,
        beforeRadius: before.radius,
        afterRadius: after.radius,
        added: after.items - before.items,
        noMore: after.noMore,
        ok: ok
      });
      if (after.noMore) break;
    }

    // 3) 去重与排序校验
    out.integrity = (await evalJs(`(() => {
      const ids = Feed.filtered.map((it) => it.id);
      const uniq = new Set(ids);
      const dists = Feed.filtered.map((it) => it.distance || 0);
      let ascending = true;
      for (let i = 1; i < dists.length; i++) { if (dists[i] + 1 < dists[i - 1]) { ascending = false; break; } }
      return { total: ids.length, unique: uniq.size, duplicate: ids.length - uniq.size, ascending: ascending, maxDist: Math.max.apply(null, dists.concat([0])), minDist: Math.min.apply(null, dists.concat([0])) };
    })()`)).result.value;

    // 4) loading 锁：加载中再次触底应被拦截
    out.lock = (await evalJs(`(async () => {
      App.state.pagination.loading = true;
      const beforeItems = Feed.items.length;
      const beforeRadius = App.state.pagination.radius;
      Feed.loadMore();
      await new Promise((r) => setTimeout(r, 300));
      const blocked = Feed.items.length === beforeItems && App.state.pagination.radius === beforeRadius;
      App.state.pagination.loading = false;
      return { blocked: blocked };
    })()`)).result.value;

    // 5) 到底文案
    out.finalStatus = (await snap()).result.value.status;

    console.log(JSON.stringify(out, null, 2));
    client.ws.close();
  } finally { browser.kill(); }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
