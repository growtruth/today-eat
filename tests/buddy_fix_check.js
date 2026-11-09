/**
 * 饭搭子修复验证（临时脚本）
 * 覆盖：商圈→坐标、编辑搭子、记一次约饭、邀请撤销/复用、骰子未选提示、会话自愈、资料待完善标签
 *
 * 用法：node tests/buddy_fix_check.js 5001 9345
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.argv[2] || 5001);
const DEBUG_PORT = Number(process.argv[3] || 9345);
const PROFILE = path.join(process.env.TEMP || '/tmp', 'weekend-eat-buddyfix');
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
  const btnByText = (label) => Array.from(document.querySelectorAll('#sheetRoot .sheet-actions button'))
    .find((b) => b.textContent === label);

  const todayStr = (() => {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  })();

  await sleep(1200);

  // ---------- 1. 添加：商圈「望京」应换成坐标 ----------
  document.querySelector('[data-tab="buddies"]').click();
  await sleep(1600);
  document.getElementById('buddyAddBtn').click();
  await sleep(350);
  document.querySelector('#buddyName').value = '小测';
  document.querySelector('#buddyArea').value = '望京';
  document.querySelector('#buddyCuisines .chip').click();
  document.querySelector('#sheetRoot .btn-primary').click();
  await sleep(2400);

  let buddy = Buddy.items.filter((item) => item.name === '小测')[0];
  out.createdLat = buddy ? buddy.lat : null;
  out.createdLng = buddy ? buddy.lng : null;
  out.createdCompleteness = buddy ? buddy.completeness : null;
  out.warnTag = !!document.querySelector('.buddy-tag--warn');

  // ---------- 2. 编辑：改预算 + 补上次见面 ----------
  Buddy.openEdit(buddy);
  await sleep(350);
  out.editTitle = text('.sheet-title');
  out.editPrefillName = (document.querySelector('#buddyName') || {}).value;
  out.editPrefillArea = (document.querySelector('#buddyArea') || {}).value;
  document.querySelector('#buddyBudget').value = '120';
  document.querySelector('#buddyLastMet').value = todayStr;
  document.querySelector('#sheetRoot .btn-primary').click();
  await sleep(2000);

  buddy = Buddy.items.filter((item) => item.name === '小测')[0];
  out.editedBudget = buddy ? buddy.budget : null;
  out.editedLastMet = buddy ? buddy.lastMet : null;
  out.editedCompleteness = buddy ? buddy.completeness : null;
  out.warnTagGone = !document.querySelector('.buddy-tag--warn');

  // ---------- 3. 抽搭子 → 记一次约饭 ----------
  document.getElementById('buddyDrawBtn').click();
  await sleep(1400);
  out.drawTitle = text('.sheet-title');
  out.drawActions = Array.from(document.querySelectorAll('#sheetRoot .sheet-actions button')).map((b) => b.textContent);
  document.querySelector('#sheetRoot .sheet-actions .btn-primary').click();
  await sleep(1800);
  buddy = Buddy.items.filter((item) => item.name === '小测')[0];
  out.metAfterDraw = buddy ? buddy.lastMet : null;

  // ---------- 4. 邀请撤销 ----------
  document.querySelector('[data-btab="list"]').click();
  await sleep(300);
  document.getElementById('buddyInviteBtn').click();
  await sleep(1600);
  out.inviteTitle = text('.sheet-title');
  out.inviteUrl = text('.invite-link');
  out.hasRevoke = !!document.querySelector('.invite-revoke');
  out.inviteNote = text('.invite-note').slice(0, 60);

  const token = ((out.inviteUrl || '').split('/i/')[1] || '').split('?')[0];
  document.querySelector('.invite-revoke').click();
  await sleep(600);
  out.revokeTitle = text('.sheet-title');
  btnByText('撤销').click();
  await sleep(1400);
  const queried = await fetch('/api/invites/' + token, { headers: { Accept: 'application/json' } })
    .then((r) => r.json());
  out.revokedStatus = queried.invite ? queried.invite.status : '';

  // ---------- 5. 邀请复用：连点两次发邀请应拿到同一 token ----------
  document.getElementById('buddyInviteBtn').click();
  await sleep(1500);
  const url1 = text('.invite-link');
  document.querySelector('.sheet-mask').click();
  await sleep(500);
  document.getElementById('buddyInviteBtn').click();
  await sleep(1500);
  const url2 = text('.invite-link');
  out.reuseSame = !!url1 && url1 === url2;
  document.querySelector('.sheet-mask').click();
  await sleep(500);

  // ---------- 6. 骰子：没选搭子时给提示，不静默换人 ----------
  Buddy.selectedId = null;
  document.querySelector('[data-btab="dice"]').click();
  await sleep(300);
  const beforeFace = text('#diceMe');
  document.getElementById('diceRollBtn').click();
  await sleep(500);
  out.diceToast = text('#toast');
  out.diceFaceUnchanged = text('#diceMe') === beforeFace;

  // ---------- 7. 会话过期自愈：模拟一次 auth_required ----------
  const originalBuddies = API.buddies;
  let first = true;
  API.buddies = function () {
    if (first) {
      first = false;
      const error = new Error('请先登录');
      error.code = 'auth_required';
      return Promise.reject(error);
    }
    return originalBuddies();
  };
  await Buddy.refresh();
  API.buddies = originalBuddies;
  out.selfHealItems = Buddy.items.length;
  out.selfHealError = Buddy.error ? (Buddy.error.message || 'error') : null;

  // ---------- 8. 首页抽搭子不能用「上次看过的店」当坐标 ----------
  const originalDraw = API.drawBuddy;
  let captured = null;
  API.drawBuddy = function (payload) {
    captured = payload;
    const error = new Error('probe');
    error.code = 'probe';
    return Promise.reject(error);
  };
  App.state.current = { id: 'fake', name: '上次看的店', lat: 1.1, lng: 2.2, cuisine: '火锅', avgPrice: 99 };
  App.state.page = 0;
  if (window.Pager) Pager.index = 0;
  App.util.toast = function () {};
  await Buddy.draw();
  out.payloadOnHome = captured;

  App.state.page = 1;
  if (window.Pager) Pager.index = 1;
  await Buddy.draw();
  out.payloadOnDetail = captured;

  API.drawBuddy = originalDraw;
  App.state.page = 0;
  if (window.Pager) Pager.index = 0;
  App.state.current = null;

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
      expression: FLOW,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception ?
        result.exceptionDetails.exception.description : result.exceptionDetails.text);
    }
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error('FAIL', error.message);
  process.exit(1);
});
