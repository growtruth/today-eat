/**
 * 分页 + 三处地图的交互验证（临时脚本）
 * 用法：node tests/maps_check.js [port] [debugPort]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.argv[2] || 5001);
const DEBUG_PORT = Number(process.argv[3] || 9348);
const PROFILE = path.join(process.env.TEMP || '/tmp', 'weekend-eat-maps');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
  return { send, ready };
}

async function waitForVersion() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch (e) { /* not ready */ }
    await sleep(250);
  }
  throw new Error('调试端口未就绪');
}

const FLOW = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (sel) => (document.querySelector(sel) || {}).textContent || '';
  const out = {};
  const fire = (el, type, x, y, id) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    pointerId: id || 1, pointerType: 'touch', isPrimary: true
  }));

  await sleep(1400);

  // ---------- 1. 游标分页 ----------
  const p = App.state.pagination;
  out.paginationStart = { radius: p.radius, offset: p.offset, noMore: p.noMore };
  out.itemsLoaded = Feed.items.length;
  out.uniqueIds = new Set(Feed.items.map((i) => i.id)).size;
  out.distanceAsc = (() => {
    const d = Feed.filtered.map((i) => i.distance || 0);
    return d.every((v, idx) => idx === 0 || v >= d[idx - 1]);
  })();

  // 本地分页：不触网
  const offsetBefore = App.state.pagination.offset;
  Feed.loadMore();
  await sleep(200);
  out.localVisible = Feed.visible;
  out.localKeptOffset = App.state.pagination.offset === offsetBefore;

  // 触底：网络翻页 / 升档
  while (App.state.pagination.loading) await sleep(200);
  const beforeCount = Feed.items.length;
  const directResult = await App.loadMoreByRadius();
  await sleep(600);
  out.afterLoadMore = {
    directResult: directResult,
    items: Feed.items.length,
    added: Feed.items.length - beforeCount,
    offset: App.state.pagination.offset,
    radius: App.state.pagination.radius,
    noMore: App.state.pagination.noMore,
    status: text('#feedStatus').slice(0, 24)
  };

  // 到底后的「看看 5km 内的」直接扩档
  const moreBtn = document.querySelector('#feedStatus .feed-more');
  out.moreBtnText = moreBtn ? moreBtn.textContent : '';
  if (moreBtn) {
    moreBtn.click();
    await sleep(2600);
    out.afterExpand = {
      filterDistance: Filters.state.distance,
      radius: App.state.pagination.radius,
      items: Feed.items.length,
      status: text('#feedStatus').slice(0, 24)
    };
  }

  // ---------- 2. 导航地图 ----------
  document.querySelector('.card').click();
  await sleep(900);
  await Nav.open('walking');
  await sleep(1800);

  const navMap = document.getElementById('navMap');
  out.navHasSvg = !!navMap.querySelector('svg');
  out.navHasAmap = !!navMap.querySelector('.amap-maps');
  out.navAttrib = text('#navMap .map-attrib');
  out.navZoomBefore = navMap.dataset.zoomLevel || '';
  out.navZoomFn = typeof MapView.zoom;
  MapView.zoom(navMap, 1);
  out.navZoomDirect = navMap.dataset.zoomLevel || '';
  document.querySelector('[data-zoom="in"]').click();
  out.navZoomImmediate = navMap.dataset.zoomLevel || '';
  document.querySelector('[data-zoom="in"]').click();
  await sleep(900);
  out.navZoomAfter = navMap.dataset.zoomLevel || '';
  out.navSvgTransform = (navMap.querySelector('svg') || {}).style ? navMap.querySelector('svg').style.transform : '';

  if (out.navHasSvg) {
    const rect = navMap.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    fire(navMap, 'pointerdown', cx, cy);
    fire(navMap, 'pointermove', cx + 46, cy + 32);
    fire(navMap, 'pointerup', cx + 46, cy + 32);
    await sleep(200);
    out.navAfterDrag = navMap.querySelector('svg').style.transform;
  }

  document.getElementById('navLocate').click();
  await sleep(700);
  out.navResetTransform = (navMap.querySelector('svg') || {}).style ? navMap.querySelector('svg').style.transform : '';

  // ---------- 3. 饭后游玩地图 ----------
  await Play.open();
  await sleep(1800);
  const playMap = document.getElementById('playMap');
  out.playHasSvg = !!playMap.querySelector('svg');
  out.playHasAmap = !!playMap.querySelector('.amap-maps');
  out.playAttrib = text('#playMap .map-attrib');
  out.playTools = document.querySelectorAll('.map-tools--play button').length;
  out.playZoomBefore = playMap.dataset.zoomLevel || '';
  document.querySelector('[data-play-zoom="in"]').click();
  document.querySelector('[data-play-zoom="in"]').click();
  await sleep(600);
  out.playZoomAfter = playMap.dataset.zoomLevel || '';
  out.playSvgTransform = playMap.querySelector('svg') ? playMap.querySelector('svg').style.transform : '';

  if (out.playHasSvg) {
    const rect = playMap.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    fire(playMap, 'pointerdown', cx, cy);
    fire(playMap, 'pointermove', cx - 40, cy - 26);
    fire(playMap, 'pointerup', cx - 40, cy - 26);
    await sleep(200);
    out.playAfterDrag = playMap.querySelector('svg').style.transform;

    const spot = playMap.querySelector('.map-spot-hit');
    out.playSpotHits = playMap.querySelectorAll('.map-spot-hit').length;
    if (spot) {
      spot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(400);
      out.playSpotSheet = text('.sheet-title');
      out.playSpotSub = text('.sheet-sub');
      const mask = document.querySelector('.sheet-mask');
      if (mask) mask.click();
      await sleep(300);
    }
  }

  document.getElementById('playMapReset').click();
  await sleep(500);
  out.playResetTransform = playMap.querySelector('svg') ? playMap.querySelector('svg').style.transform : '';

  // 反复切换预算档：高德实例不应叠加
  document.querySelectorAll('#playBudget [data-minutes]').forEach((btn) => btn.click());
  await sleep(1600);
  out.playAmapInstances = playMap.querySelectorAll('.amap-maps').length;
  out.playSvgCount = playMap.querySelectorAll('svg').length;
  out.playToolStillThere = document.querySelectorAll('.map-tools--play button').length;

  // ---------- 4. 定位详情地图 ----------
  App.state.location = {
    lat: 39.9963, lng: 116.4703, label: '北京市朝阳区望京街道', city: '北京市',
    manual: true, source: 'search'
  };
  {
    LocDetail.open();
    for (let i = 0; i < 12; i++) {
      await sleep(700);
      if (document.querySelector('#locMap svg') || document.querySelector('#locMap .amap-maps')) break;
    }
    const locMap = document.getElementById('locMap');
    out.locOpen = document.getElementById('locLayer').classList.contains('is-open');
    out.locHint = text('#locMapHint');
    out.locHasSvg = !!locMap.querySelector('svg');
    out.locHasAmap = !!locMap.querySelector('.amap-maps');
    out.locZoomLevel = locMap.dataset.zoomLevel || '';
    document.getElementById('locZoomIn').click();
    await sleep(700);
    out.locZoomAfter = locMap.dataset.zoomLevel || '';
    out.locSvgTransform = locMap.querySelector('svg') ? locMap.querySelector('svg').style.transform : '';
  }

  return out;
})()`;

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('未找到 Edge：' + EDGE);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const browser = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--force-device-scale-factor=1',
    '--window-size=492,932',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const version = await waitForVersion();
    const client = connect(version.webSocketDebuggerUrl);
    await client.ready;
    const { targetId } = await client.send('Target.createTarget', {
      url: `http://127.0.0.1:${PORT}/?nogeo=1`
    });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);
    await sleep(1600);

    const result = await client.send('Runtime.evaluate', {
      expression: FLOW, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception ?
        result.exceptionDetails.exception.description : result.exceptionDetails.text);
    }
    const out = result.result.value;
    const zoomMoved = (before, after, transform, hasAmap) => {
      if (hasAmap) return after !== '' && after !== before;
      return typeof transform === 'string' && /scale\((?!1\))/.test(transform);
    };
    const checks = [
      ['首屏有数据', (out.itemsLoaded || 0) > 0, out.itemsLoaded],
      ['唯一门店数与加载数一致', out.uniqueIds === out.itemsLoaded, out.uniqueIds + '/' + out.itemsLoaded],
      ['列表按距离升序', out.distanceAsc === true, out.distanceAsc],
      ['本地分页不触网', out.localKeptOffset === true, out.localKeptOffset],
      ['翻页能拿到新店', !out.afterLoadMore || out.afterLoadMore.added > 0 || out.afterLoadMore.noMore,
        out.afterLoadMore],
      ['导航地图已渲染', out.navHasSvg || out.navHasAmap, out.navHasSvg + '/' + out.navHasAmap],
      ['导航缩放生效', zoomMoved(out.navZoomBefore, out.navZoomAfter, out.navSvgTransform, out.navHasAmap),
        out.navZoomBefore + '→' + out.navZoomAfter + ' ' + (out.navSvgTransform || '')],
      ['导航可拖拽/复位', !out.navHasSvg || (!!out.navAfterDrag && /scale\(1\)/.test(out.navResetTransform)),
        out.navAfterDrag + ' | ' + out.navResetTransform],
      ['游玩地图已渲染', out.playHasSvg || out.playHasAmap, out.playHasSvg + '/' + out.playHasAmap],
      ['游玩控件齐全', out.playTools === 3, out.playTools],
      ['游玩缩放生效', zoomMoved(out.playZoomBefore, out.playZoomAfter, out.playSvgTransform, out.playHasAmap),
        out.playZoomBefore + '→' + out.playZoomAfter],
      ['游玩可拖拽/复位', !out.playHasSvg || (!!out.playAfterDrag && /scale\(1\)/.test(out.playResetTransform)),
        out.playAfterDrag + ' | ' + out.playResetTransform],
      ['地图实例不叠加', (out.playAmapInstances || 0) <= 1 && (out.playSvgCount || 0) <= 1,
        out.playAmapInstances + '/' + out.playSvgCount],
      ['定位详情地图已渲染', out.locHasSvg || out.locHasAmap, out.locHasSvg + '/' + out.locHasAmap],
      ['定位缩放生效', zoomMoved(out.locZoomLevel, out.locZoomAfter, out.locSvgTransform, out.locHasAmap),
        out.locZoomLevel + '→' + out.locZoomAfter]
    ];

    let failed = 0;
    checks.forEach(([name, ok, detail]) => {
      if (ok) {
        console.log('  OK  ' + name);
      } else {
        failed++;
        console.log('FAIL  ' + name + ' :: ' + JSON.stringify(detail));
      }
    });
    console.log('\n通过 ' + (checks.length - failed) + ' 项，失败 ' + failed + ' 项');
    if (failed) process.exitCode = 1;
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error('FAIL', error.message);
  process.exit(1);
});
