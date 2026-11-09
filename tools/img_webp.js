/**
 * 生成 WebP 两档图（零第三方依赖，使用 Chromium Canvas 编码）
 *
 * 输入：运行中的 Flask 静态图片（static/img/*.jpg）
 * 输出：
 *   - static/img/<name>.webp        最大宽 1080，q=0.80
 *   - static/img/thumb/<name>.webp  最大宽 480，q=0.78
 *
 * 用法：node tools/img_webp.js [--port 5000] [--debug-port 9335]
 * 说明：源图已是 1080w JPEG，WebP 用于进一步压缩传输；原 JPEG 保留作回退。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'static', 'img');
const THUMB_DIR = path.join(IMG_DIR, 'thumb');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(argOf('port', 5000));
const DEBUG_PORT = Number(argOf('debug-port', 9335));
const PROFILE = path.join(process.env.TEMP || '/tmp', 'eat-webp-cdp');

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

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('未找到 Edge：' + EDGE);
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const browser = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--force-device-scale-factor=1',
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

    const files = fs.readdirSync(IMG_DIR).filter((name) => /\.jpe?g$/i.test(name));
    const stats = [];

    for (const file of files) {
      const name = file.replace(/\.jpe?g$/i, '');
      const jpgLarge = fs.statSync(path.join(IMG_DIR, name + '.jpg')).size;
      const jpgThumb = fs.statSync(path.join(THUMB_DIR, name + '.jpg')).size;
      const row = { name, jpgLarge, jpgThumb, webpLarge: 0, webpThumb: 0 };

      for (const spec of [
        { dir: IMG_DIR, width: 1080, quality: 0.80, key: 'webpLarge' },
        { dir: THUMB_DIR, width: 480, quality: 0.78, key: 'webpThumb' }
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
          return canvas.toDataURL('image/webp', ${spec.quality});
        })()`;

        const result = await client.send('Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true
        }, sessionId);

        if (result.exceptionDetails) {
          throw new Error('编码失败 ' + file + ': ' + result.exceptionDetails.text);
        }
        const dataUrl = result.result.value || '';
        if (dataUrl.indexOf('data:image/webp') !== 0) {
          throw new Error('浏览器不支持 WebP 编码：' + file);
        }
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const outPath = path.join(spec.dir, name + '.webp');
        fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
        row[spec.key] = fs.statSync(outPath).size;
      }
      stats.push(row);
    }

    const sum = (key) => stats.reduce((total, row) => total + row[key], 0);
    stats.forEach((row) => {
      console.log(
        `${row.name.padEnd(16)} large ${(row.jpgLarge / 1024).toFixed(0).padStart(4)}→` +
        `${(row.webpLarge / 1024).toFixed(0).padStart(4)}KB   thumb ` +
        `${(row.jpgThumb / 1024).toFixed(0).padStart(3)}→${(row.webpThumb / 1024).toFixed(0).padStart(3)}KB`
      );
    });
    console.log(
      `\n大图 ${(sum('jpgLarge') / 1024).toFixed(0)}KB → ${(sum('webpLarge') / 1024).toFixed(0)}KB` +
      `（-${(100 - sum('webpLarge') / sum('jpgLarge') * 100).toFixed(0)}%）`
    );
    console.log(
      `缩略图 ${(sum('jpgThumb') / 1024).toFixed(0)}KB → ${(sum('webpThumb') / 1024).toFixed(0)}KB` +
      `（-${(100 - sum('webpThumb') / sum('jpgThumb') * 100).toFixed(0)}%）`
    );

    client.ws.close();
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
