/**
 * 图片优化脚本（零第三方依赖）
 *
 * 通过 Chromium 的 Canvas 编码，把 static/img 下的原图重新采样为：
 *   - large: 最大宽度 1080，JPEG q=0.82  → static/img/<name>.jpg
 *   - thumb: 最大宽度 480， JPEG q=0.78  → static/img/thumb/<name>.jpg
 *
 * 依赖：Node 22（内置 WebSocket）、本机 Edge/Chrome、运行中的 Flask 服务（同源取图）。
 * 用法：node tools/img_optimize.js [--port 5000] [--debug-port 9333]
 * 注意：脚本会就地覆盖 static/img/*.jpg，重复执行会造成二次压缩。
 *       如需重跑，请先从需求包还原原图。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'static', 'img');
const THUMB_DIR = path.join(IMG_DIR, 'thumb');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(argOf('port', 5000));
const DEBUG_PORT = Number(argOf('debug-port', 9333));
const PROFILE = path.join(process.env.TEMP || '/tmp', 'weekend-eat-cdp');

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

  function send(method, params, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    });
  }

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

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('未找到 Edge：' + EDGE);
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const browser = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--force-device-scale-factor=1',
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
    await sleep(1200);

    const files = fs.readdirSync(IMG_DIR).filter((name) => /\.(jpe?g|png)$/i.test(name));
    const stats = [];

    for (const file of files) {
      const name = file.replace(/\.(jpe?g|png)$/i, '').replace(/\.(jpe?g|png)$/i, '');
      const before = fs.statSync(path.join(IMG_DIR, file)).size;

      for (const spec of [
        { dir: IMG_DIR, width: 1080, quality: 0.82, suffix: '' },
        { dir: THUMB_DIR, width: 480, quality: 0.78, suffix: '' }
      ]) {
        const expression = `(async () => {
          const img = new Image();
          img.src = '/static/img/${file}?t=' + Date.now();
          await img.decode();
          const w = Math.min(${spec.width}, img.naturalWidth);
          const h = Math.round(img.naturalHeight * w / img.naturalWidth);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL('image/jpeg', ${spec.quality});
        })()`;

        const result = await client.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        }, sessionId);

        if (result.exceptionDetails) {
          throw new Error('渲染失败 ' + file + ': ' + result.exceptionDetails.text);
        }
        const dataUrl = result.result.value;
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const outPath = path.join(spec.dir, name + '.jpg');
        fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));

        if (spec.width === 1080) {
          const after = fs.statSync(outPath).size;
          stats.push({ file: name, before, after, thumb: 0 });
        } else {
          const item = stats[stats.length - 1];
          item.thumb = fs.statSync(outPath).size;
        }
      }
    }

    const totalBefore = stats.reduce((sum, s) => sum + s.before, 0);
    const totalAfter = stats.reduce((sum, s) => sum + s.after + s.thumb, 0);
    stats.forEach((s) => {
      console.log(
        `${s.file.padEnd(16)} ${(s.before / 1024).toFixed(0).padStart(5)}KB → ` +
        `${(s.after / 1024).toFixed(0).padStart(4)}KB + ${(s.thumb / 1024).toFixed(0).padStart(3)}KB`
      );
    });
    console.log(`\n合计 ${(totalBefore / 1024 / 1024).toFixed(2)}MB → ` +
      `${(totalAfter / 1024 / 1024).toFixed(2)}MB（-${(100 - totalAfter / totalBefore * 100).toFixed(0)}%）`);

    client.ws.close();
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
