/**
 * 端到端冒烟测试（零依赖，Node 22 + 本机 Edge）
 *
 * 覆盖：首屏渲染 → 菜系/人均筛选 → 人均分档随品类重置 → 详情 → 打卡
 *       → 出行方式 → 导航 → 饭后游玩 → 打卡页统计。
 *
 * 用法：node tests/e2e_smoke.js [--port 5000] [--debug-port 9334]
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(argOf('port', 5000));
const DEBUG_PORT = Number(argOf('debug-port', 9334));
const PROFILE = path.join(process.env.TEMP || '/tmp', 'weekend-eat-e2e');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return { ws, send, ready };
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
  const chip = (label) => Array.from(document.querySelectorAll('#cuisineRow .chip'))
    .find((b) => b.textContent.indexOf(label) >= 0);
  const out = {};

  await sleep(900);
  out.cards = document.querySelectorAll('.card').length;
  out.count = text('#condCount');
  out.firstSrcset = (document.querySelector('.card img') || {}).srcset || '';
  out.webpSet = (document.querySelector('.card picture source') || {}).srcset || '';
  out.brand = text('.home-title h1');

  // 首次使用提示：出现 → 关闭 → 记住已读
  out.hintShown = !document.getElementById('gestureHint').hidden;
  document.getElementById('gestureHintClose').click();
  await sleep(420);
  out.hintClosed = document.getElementById('gestureHint').hidden;
  out.hintStored = !!(JSON.parse(localStorage.getItem('weekend_eat_v1') || '{}').prefs || {}).gestureHintAt;

  // 营业状态解析：跨夜、白天、缺失三种情况
  out.openLateNight = App.util.openState({ openTime: '22:00', closeTime: '次日 02:00' }, new Date(2026, 0, 1, 1, 0)).open;
  out.openLateNoon = App.util.openState({ openTime: '22:00', closeTime: '次日 02:00' }, new Date(2026, 0, 1, 12, 0)).open;
  out.openUnknown = App.util.openState({}).known;

  // 周末模式：默认 solo，可切聚餐，关闭后恢复全量
  const sw = document.getElementById('weekendSwitch');
  sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(380);
  out.weekendPanelOpen = !document.getElementById('weekendPanel').hidden;
  out.soloCount = text('#condCount');
  out.soloBanner = text('#weekendBannerText');
  out.soloBadge = document.body.innerText.indexOf('一人食') >= 0;
  out.soloIds = Array.from(document.querySelectorAll('.card')).map((c) => c.dataset.id).join(',');

  document.querySelector('#weekendModes [data-submode="group"]').click();
  await sleep(380);
  out.groupCount = text('#condCount');
  out.groupBanner = text('#weekendBannerText');
  out.groupIds = Array.from(document.querySelectorAll('.card')).map((c) => c.dataset.id).join(',');
  out.storedSubmode = (JSON.parse(localStorage.getItem('weekend_eat_v1') || '{}').prefs || {}).weekendSubmode;

  sw.checked = false; sw.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(320);
  out.weekendOffCount = text('#condCount');
  out.weekendPanelClosed = document.getElementById('weekendPanel').hidden;

  // 只看营业中：切换 → 条件条出现 → 再切回
  const openToggle = document.querySelector('[data-toggle="openOnly"]');
  openToggle.click();
  await sleep(320);
  out.openFilterOn = openToggle.classList.contains('is-on');
  out.openCondChip = text('#condChips').indexOf('营业中') >= 0;
  openToggle.click();
  await sleep(320);
  out.openFilterOff = !openToggle.classList.contains('is-on');

  chip('咖啡').click();
  await sleep(300);
  out.coffeeCount = text('#condCount');

  document.querySelector('[data-filter="perCapita"]').click();
  await sleep(320);
  out.sheetTitle = text('.sheet-title');
  out.tierOptions = Array.from(document.querySelectorAll('#sheetRoot .option')).map((b) => b.textContent.trim());
  document.querySelector('#sheetRoot .option').click();
  await sleep(260);
  document.querySelector('#sheetRoot .btn-primary').click();
  await sleep(300);
  out.afterTierCount = text('#condCount');
  out.perCapitaLabel = text('[data-filter="perCapita"] .chip-label');

  chip('火锅').click();
  await sleep(320);
  out.afterCuisineCount = text('#condCount');
  out.perCapitaAfterCuisine = text('[data-filter="perCapita"] .chip-label');

  document.querySelector('.card').click();
  await sleep(900);
  out.detailName = text('#detailName');
  out.bubbles = document.querySelectorAll('.bubble').length;
  out.notes = document.querySelectorAll('.note').length;
  out.galleryCount = text('#galleryCount');

  document.getElementById('checkinBtn').click();
  await sleep(250);
  out.checkinLabel = document.getElementById('checkinBtn').textContent.trim();
  out.stored = (JSON.parse(localStorage.getItem('weekend_eat_v1') || '{}').checkins || []).length;

  document.getElementById('decideBtn').click();
  await sleep(350);
  out.modes = document.querySelectorAll('.mode-card').length;
  document.querySelector('#sheetRoot .btn-primary').click();
  await sleep(1400);
  out.navMinutes = text('#navMinutes');
  out.navDistance = text('#navDistance');
  out.navSvg = !!document.querySelector('#navMap svg');
  out.navStep = text('#navSteps').slice(0, 24);

  document.getElementById('goPlayBtn').click();
  await sleep(1500);
  out.spotCards = document.querySelectorAll('.spot-card').length;
  out.firstSmooth = text('.spot-smooth');
  out.playSvg = !!document.querySelector('#playMap svg');

  const minutesOf = (el) => {
    const matched = (el.textContent || '').match(/步行 (\\d+) 分钟/);
    return matched ? Number(matched[1]) : 999;
  };
  out.playAllCount = document.querySelectorAll('.spot-card').length;
  document.querySelector('#playBudget [data-minutes="30"]').click();
  await sleep(320);
  out.budgetOn = document.querySelector('#playBudget [data-minutes="30"]').classList.contains('is-on');
  out.play30Max = Math.max.apply(null, Array.from(document.querySelectorAll('.spot-card .spot-sub')).map(minutesOf).concat([0]));

  // 用 10 分钟预算验证过滤逻辑（当前点位都在 16 分钟内，30 分钟不会筛掉）
  Play.budget = 10;
  Play.render(Play.data, Play.item);
  await sleep(120);
  out.play10Count = document.querySelectorAll('.spot-card').length;
  out.play10Max = Math.max.apply(null, Array.from(document.querySelectorAll('.spot-card .spot-sub')).map(minutesOf).concat([0]));
  document.querySelector('#playBudget [data-minutes="0"]').click();
  await sleep(320);
  out.playRestored = document.querySelectorAll('.spot-card').length;

  document.querySelector('[data-tab="checkin"]').click();
  await sleep(600);
  out.statTotal = text('#statTotal');
  out.checkinCards = document.querySelectorAll('.checkin-card').length;
  out.tabActive = !!document.querySelector('.tab.is-active[data-tab="checkin"]');

  // ---------- 团购半弹层 ----------
  document.querySelector('[data-tab="home"]').click();
  await sleep(600);
  document.querySelector('.card').click();
  await sleep(900);
  out.dealsBtnVisible = !!document.getElementById('dealsBtn');
  out.dealDebug = {
    page: document.body.dataset.page,
    hasItem: !!(window.Detail && Detail.item),
    cards: document.querySelectorAll('.card').length,
    pager: window.Pager ? Pager.index : -1
  };
  document.getElementById('dealsBtn').click();
  await sleep(900);
  const dealMask = document.querySelector('.sheet-mask');
  out.dealSheetTitle = dealMask ? text('.sheet-title') : '';
  out.dealLinks = dealMask ? document.querySelectorAll('.deal-link, .deal-card').length : 0;
  out.dealText = text('#sheetRoot').slice(0, 80);
  if (dealMask) dealMask.click();
  await sleep(420);

  // ---------- 饭搭子：打开、添加、抽取 ----------
  document.querySelector('[data-tab="buddies"]').click();
  await sleep(1600);
  out.buddyOpen = document.getElementById('buddyLayer').classList.contains('is-open');
  out.buddyMe = text('#buddyMe');
  out.buddyTabActive = !!document.querySelector('.tab.is-active[data-tab="buddies"]');

  document.getElementById('buddyAddBtn').click();
  await sleep(450);
  out.buddyFormTitle = text('.sheet-title');
  document.querySelector('#buddyName').value = '小e2e';
  document.querySelector('#buddyArea').value = '望京';
  document.querySelector('#buddyCuisines .chip').click();
  document.querySelector('#sheetRoot .btn-primary').click();
  await sleep(1100);
  out.buddyCount = document.querySelectorAll('.buddy-row').length;
  out.buddyNameShown = text('.buddy-name');

  document.getElementById('buddyDrawBtn').click();
  await sleep(900);
  out.buddyDrawTitle = text('.sheet-title');
  out.buddyBars = document.querySelectorAll('.bar-row').length;
  out.buddyDrawName = text('.draw-buddy h3');
  document.querySelector('.sheet-mask').click();
  await sleep(420);

  // ---------- 骰子结账 ----------
  document.querySelector('[data-btab="dice"]').click();
  await sleep(400);
  document.querySelector('#dicePick .dice-chip').click();
  document.getElementById('diceRollBtn').click();
  await sleep(1800);
  out.diceMeFace = text('#diceMe');
  out.diceBuddyFace = text('#diceBuddy');
  out.diceResult = text('#diceResult');
  out.diceHistory = document.querySelectorAll('.dice-history-row').length;

  // ---------- 抽店结果分享入口 ----------
  document.querySelector('[data-tab="draw"]').click();
  await sleep(700);
  out.shareLabel = text('#drawShare');
  const shareBtn = document.getElementById('drawShare');
  out.shareHasIcon = !!(shareBtn && shareBtn.querySelector('svg'));
  Draw.close();
  await sleep(300);

  // ---------- 邀请链接 ----------
  document.querySelector('[data-btab="list"]').click();
  await sleep(200);
  document.getElementById('buddyInviteBtn').click();
  await sleep(900);
  out.inviteTitle = text('.sheet-title');
  out.inviteLink = text('.invite-link');
  document.querySelector('.sheet-mask').click();
  await sleep(400);

  // ---------- 浏览器返回键：详情 -> 首页；浮层打开时先关浮层 ----------
  document.getElementById('buddyClose').click();
  await sleep(400);
  document.querySelector('.card').click();
  await sleep(900);
  out.pageBeforeBack = document.body.dataset.page;
  history.back();
  await sleep(700);
  out.pageAfterBack = document.body.dataset.page;

  // 浮层里的返回键：先关浮层，不退出站点
  document.querySelector('[data-tab="checkin"]').click();
  await sleep(500);
  history.back();
  await sleep(600);
  out.layerClosedByBack = !document.getElementById('checkinLayer').classList.contains('is-open');
  out.pageAfterLayerBack = document.body.dataset.page;

  // 详情页「抽个搭子陪我吃」：直接复用目录并给出结果
  document.querySelector('.card').click();
  await sleep(900);
  document.getElementById('detailBuddyBtn').click();
  await sleep(2000);
  out.storeBuddyTitle = text('.sheet-title');
  out.storeBuddyName = text('.draw-buddy h3');
  document.querySelector('.sheet-mask').click();
  await sleep(400);

  // ---------- 美食雷达 ----------
  App.goHome(false);
  await sleep(900);
  const radarOpen = () => document.getElementById('radarLayer').classList.contains('is-open');
  out.radarEntry = !!document.getElementById('radarBtn');
  document.getElementById('radarBtn').click();
  await sleep(800);
  out.radarOpen = radarOpen();
  out.radarBlips = document.querySelectorAll('.radar-blip').length;
  out.radarExpected = Feed.filtered.length;
  out.radarRings = document.querySelectorAll('.radar-ring-label').length;
  out.radarRingText = text('#radarRings');
  out.radarSub = text('#radarSub');
  out.radarCompass = ['北', '东', '南', '西']
    .every((label) => text('#radarStage').indexOf(label) >= 0);
  out.radarLegend = document.querySelectorAll('.radar-legend-item').length;
  out.radarTabHidden = document.getElementById('tabbar').classList.contains('is-hidden');

  const firstBlip = document.querySelector('.radar-blip');
  out.radarBlipLabel = firstBlip ? firstBlip.getAttribute('aria-label') : '';
  if (firstBlip) firstBlip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(400);
  out.radarCardName = text('#radarCardName');
  out.radarMeta = text('#radarMeta');
  out.radarSelected = document.querySelectorAll('.radar-blip.is-selected').length;
  out.radarDirection = /(北|东|南|西)/.test(out.radarMeta);
  out.radarTag = document.querySelectorAll('.radar-tag').length;

  document.getElementById('radarScan').click();
  await sleep(1200);
  out.radarPicked = document.querySelectorAll('.radar-blip.is-picked').length;
  out.radarPickedKicker = text('#radarKicker');
  out.radarPickedName = text('#radarCardName');

  document.getElementById('radarDetailBtn').click();
  await sleep(1000);
  out.radarDetailPage = document.body.dataset.page;
  out.radarDetailName = text('#detailName');

  // 返回键优先关闭雷达，而不是直接退出站点
  App.goHome(false);
  await sleep(900);
  document.getElementById('radarBtn').click();
  await sleep(600);
  history.back();
  await sleep(700);
  out.radarClosedByBack = !radarOpen();
  out.radarPageAfterBack = document.body.dataset.page;

  // 雷达跟随筛选：川菜只有 1 家，与当前 2 家区分开
  chip('川菜').click();
  await sleep(450);
  document.getElementById('radarBtn').click();
  await sleep(700);
  out.radarFilteredBlips = document.querySelectorAll('.radar-blip').length;
  out.radarFilteredSub = text('#radarSub');
  document.getElementById('radarClose').click();
  await sleep(450);
  chip('川菜').click();
  await sleep(350);

  // ---------- 前端错误上报 ----------
  const telBefore = window.Telemetry ? Telemetry.count().sent : -1;
  window.dispatchEvent(new ErrorEvent('error', { message: 'e2e-probe', filename: 'e2e.js', lineno: 1 }));
  await sleep(400);
  out.telemetryReady = telBefore >= 0;
  out.telemetrySent = window.Telemetry ? Telemetry.count().sent > telBefore : false;

  out.scrollWidth = document.documentElement.scrollWidth;
  out.innerWidth = window.innerWidth;
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
    await sleep(1500);

    const result = await client.send('Runtime.evaluate', {
      expression: FLOW,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception ?
        result.exceptionDetails.exception.description : result.exceptionDetails.text);
    }
    const out = result.result.value;

    const checks = [
      ['品牌名为今天吃啥', out.brand === '今天吃啥', out.brand],
      ['首屏 12 张卡片', out.cards === 12, out.cards],
      ['周末面板默认展开', out.weekendPanelOpen === true, out.weekendPanelOpen],
      ['solo 模式筛出 11 家', /11/.test(out.soloCount), out.soloCount],
      ['solo 文案正确', out.soloBanner.indexOf('一个人') >= 0, out.soloBanner],
      ['solo 卡片带一人食标签', out.soloBadge === true, out.soloBadge],
      ['首屏出现手势提示', out.hintShown === true, out.hintShown],
      ['提示可关闭', out.hintClosed === true, out.hintClosed],
      ['提示已读会记住', out.hintStored === true, out.hintStored],
      ['跨夜营业判定正确', out.openLateNight === true, out.openLateNight],
      ['白天未营业判定正确', out.openLateNoon === false, out.openLateNoon],
      ['缺少营业时间视为未知', out.openUnknown === false, out.openUnknown],
      ['营业中筛选可开启', out.openFilterOn === true, out.openFilterOn],
      ['营业中进入条件条', out.openCondChip === true, out.openCondChip],
      ['营业中筛选可关闭', out.openFilterOff === true, out.openFilterOff],
      ['两种模式结果集不同', out.groupIds !== out.soloIds, out.soloIds + ' / ' + out.groupIds],
      ['聚餐文案正确', out.groupBanner.indexOf('聚餐') >= 0, out.groupBanner],
      ['子模式持久化', out.storedSubmode === 'group', out.storedSubmode],
      ['关闭后恢复全量', /16/.test(out.weekendOffCount), out.weekendOffCount],
      ['关闭后面板收起', out.weekendPanelClosed === true, out.weekendPanelClosed],
      ['首页共 16 家', out.count.indexOf('16') >= 0, out.count],
      ['卡片带 1x/2x 图源', out.firstSrcset.indexOf(' 1x') >= 0 && out.firstSrcset.indexOf(' 2x') >= 0, out.firstSrcset.slice(0, 60)],
      ['卡片优先使用 WebP', out.webpSet.indexOf('.webp 1x') >= 0, out.webpSet.slice(0, 70)],
      ['筛咖啡后 2 家', out.coffeeCount.indexOf('2') >= 0, out.coffeeCount],
      ['人均弹层标题正确', out.sheetTitle === '人均区间', out.sheetTitle],
      ['饮品分档为 50 内', out.tierOptions[0] === '50 内', out.tierOptions.join('/')],
      ['选档后条件条更新', out.perCapitaLabel.indexOf('50 内') >= 0, out.perCapitaLabel],
      ['切火锅后人均重置', out.perCapitaAfterCuisine === '人均', out.perCapitaAfterCuisine],
      ['详情页标题', out.detailName.length > 0, out.detailName],
      ['泡泡已生成', out.bubbles > 0, out.bubbles],
      ['笔记流已渲染', out.notes > 0, out.notes],
      ['画廊计数', /^1\/\d+$/.test(out.galleryCount), out.galleryCount],
      ['打卡写入本地', out.stored === 1, out.stored],
      ['出行方式 3 项', out.modes === 3, out.modes],
      ['导航有分钟数', Number(out.navMinutes) > 0, out.navMinutes],
      ['导航渲染 SVG', out.navSvg === true, out.navSvg],
      ['游玩点位 8 个', out.spotCards === 8, out.spotCards],
      ['顺路度展示', /顺路度 \d+%/.test(out.firstSmooth), out.firstSmooth],
      ['游玩页有 8 个点位', out.playAllCount === 8, out.playAllCount],
      ['时间预算按钮生效', out.budgetOn === true, out.budgetOn],
      ['30 分钟内保留全部短途点位', out.play30Max <= 30, out.play30Max],
      ['10 分钟预算筛出子集', out.play10Count > 0 && out.play10Count < out.playAllCount, out.play10Count + '/' + out.playAllCount],
      ['筛出的点位都在预算内', out.play10Max <= 10, out.play10Max],
      ['时间筛选可切回不限', out.budgetOn === true && out.playRestored === out.playAllCount, out.playRestored],
      ['打卡页统计为 1', out.statTotal === '1', out.statTotal],
      ['打卡页 tab 高亮', out.tabActive === true, out.tabActive],
      ['无横向溢出', out.scrollWidth <= out.innerWidth + 1, out.scrollWidth + '/' + out.innerWidth],
      ['详情页有团购入口', out.dealsBtnVisible === true, out.dealsBtnVisible],
      ['团购弹层标题', out.dealSheetTitle === '这家店的团购', out.dealSheetTitle + ' / ' + JSON.stringify(out.dealDebug)],
      ['团购给出平台入口或套餐', out.dealLinks >= 1, out.dealLinks],
      ['搭子浮层可打开', out.buddyOpen === true, out.buddyOpen],
      ['搭子身份已建立', out.buddyMe.indexOf('本机身份') >= 0, out.buddyMe],
      ['搭子 tab 高亮', out.buddyTabActive === true, out.buddyTabActive],
      ['添加表单标题', out.buddyFormTitle === '添加饭搭子', out.buddyFormTitle],
      ['搭子已加入目录', out.buddyCount === 1, out.buddyCount],
      ['目录显示昵称', out.buddyNameShown.indexOf('小e2e') >= 0, out.buddyNameShown],
      ['抽搭子结果标题', out.buddyDrawTitle === '陪你吃的是 TA', out.buddyDrawTitle],
      ['抽取返回权重拆解', out.buddyBars === 4, out.buddyBars],
      ['抽中的是刚添加的搭子', out.buddyDrawName.indexOf('小e2e') >= 0, out.buddyDrawName],
      ['骰子点数已落定', /^[1-6]$/.test(out.diceMeFace) && /^[1-6]$/.test(out.diceBuddyFace), out.diceMeFace + ':' + out.diceBuddyFace],
      ['结账规则文案', out.diceResult.indexOf('AA') >= 0 || out.diceResult.indexOf('结账') >= 0, out.diceResult],
      ['骰子历史已写入', out.diceHistory >= 1, out.diceHistory],
      ['抽店结果有分享入口', out.shareLabel.indexOf('分享') >= 0 && out.shareHasIcon, out.shareLabel],
      ['邀请弹层标题', out.inviteTitle === '邀请饭搭子', out.inviteTitle],
      ['邀请链接可用', /\/i\/[A-Za-z0-9_-]{10,}/.test(out.inviteLink), out.inviteLink],
      ['详情页返回首页', out.pageBeforeBack === '1' && out.pageAfterBack === '0', out.pageBeforeBack + '->' + out.pageAfterBack],
      ['返回键先关浮层', out.layerClosedByBack === true, out.layerClosedByBack],
      ['关浮层后仍留首页', out.pageAfterLayerBack === '0', out.pageAfterLayerBack],
      ['详情页抽搭子入口可用', out.storeBuddyTitle === '陪你吃的是 TA', out.storeBuddyTitle],
      ['抽到的是目录里的搭子', out.storeBuddyName.indexOf('小e2e') >= 0, out.storeBuddyName],
      ['雷达入口存在', out.radarEntry === true, out.radarEntry],
      ['雷达可打开', out.radarOpen === true, out.radarOpen],
      ['圆点数与筛选结果一致', out.radarBlips === out.radarExpected && out.radarBlips >= 2,
        out.radarBlips + '/' + out.radarExpected],
      ['三层距离环齐全', out.radarRings === 3, out.radarRings],
      ['距离环为累计统计', out.radarRingText.indexOf('3km 内 ' + out.radarExpected + ' 家') >= 0,
        out.radarRingText],
      ['方位标注齐全', out.radarCompass === true, out.radarCompass],
      ['图例按菜系分色', out.radarLegend >= 1, out.radarLegend],
      ['雷达打开时收起 tabbar', out.radarTabHidden === true, out.radarTabHidden],
      ['点选圆点显示店名与方位', out.radarCardName.length > 0 && out.radarDirection === true,
        out.radarCardName + ' / ' + out.radarMeta],
      ['点选高亮唯一', out.radarSelected === 1, out.radarSelected],
      ['选中点带名称标签', out.radarTag === 1, out.radarTag],
      ['扫描标出推荐店', out.radarPicked === 1 && out.radarPickedKicker === '雷达推荐',
        out.radarPicked + '/' + out.radarPickedKicker],
      ['雷达推荐可进详情', out.radarDetailPage === '1' && out.radarDetailName === out.radarPickedName,
        out.radarDetailPage + ' / ' + out.radarDetailName + ' vs ' + out.radarPickedName],
      ['返回键先关雷达', out.radarClosedByBack === true && out.radarPageAfterBack === '0',
        out.radarClosedByBack + '/' + out.radarPageAfterBack],
      ['雷达跟随筛选取数', out.radarFilteredBlips === 1, out.radarFilteredBlips],
      ['筛选后雷达统计同步', out.radarFilteredSub.indexOf('1 家') >= 0, out.radarFilteredSub],
      ['错误上报已加载', out.telemetryReady === true, out.telemetryReady],
      ['错误能被上报', out.telemetrySent === true, out.telemetrySent]
    ];

    let failed = 0;
    checks.forEach(([name, ok, detail]) => {
      if (!ok) failed++;
      console.log(`${ok ? '  OK' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
    });
    console.log(`\n通过 ${checks.length - failed} 项，失败 ${failed} 项`);

    if (args.indexOf('--shots') >= 0) {
      const shotDir = path.join(ROOT, 'shots');
      fs.mkdirSync(shotDir, { recursive: true });
      const capture = async (name) => {
        const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(data, 'base64'));
        console.log('  shot ' + name);
      };
      const run = (expression) => client.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      }, sessionId);

      await capture('05-checkin');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('[data-tab=\"home\"]').click();await s(700);})()");
      await capture('01-home');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));let guard=0;while(document.querySelector('#condChips .cond-chip')&&guard++<6){document.querySelector('#condChips .cond-chip').click();await s(180);}const sw=document.getElementById('weekendSwitch');sw.checked=true;sw.dispatchEvent(new Event('change',{bubbles:true}));await s(300);document.querySelector('#weekendModes [data-submode=\"solo\"]').click();await s(500);})()");
      await capture('01b-home-weekend');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));const sw=document.getElementById('weekendSwitch');sw.checked=false;sw.dispatchEvent(new Event('change',{bubbles:true}));await s(400);document.querySelector('.card').click();await s(1000);})()");
      await capture('02-detail');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.getElementById('decideBtn').click();await s(350);document.querySelector('#sheetRoot .btn-primary').click();await s(1500);})()");
      await capture('03-nav');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.getElementById('goPlayBtn').click();await s(1500);})()");
      await capture('04-play');

      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('[data-tab=\"home\"]').click();await s(700);document.querySelector('[data-filter=\"perCapita\"]').click();await s(450);})()");
      await capture('06-filter');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('.sheet-mask').click();await s(400);App.openSourceSheet();await s(1000);})()");
      await capture('07-source');

      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('.sheet-mask').click();await s(400);document.querySelector('[data-tab=\"buddies\"]').click();await s(1500);})()");
      await capture('08-buddy');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('[data-btab=\"dice\"]').click();await s(400);document.getElementById('diceRollBtn').click();await s(1600);})()");
      await capture('09-dice');
      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('[data-tab=\"home\"]').click();await s(700);document.querySelector('.card').click();await s(900);document.getElementById('dealsBtn').click();await s(1000);})()");
      await capture('10-deals');

      await run("(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));document.querySelector('.sheet-mask').click();await s(400);document.querySelector('[data-tab=\"draw\"]').click();await s(900);})()");
      await capture('12-draw');
    }

    client.ws.close();
    if (failed) process.exitCode = 1;
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
