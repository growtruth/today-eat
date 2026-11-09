/* 前端错误上报：只报错，不采集用户数据；单页最多 6 条，同错只报一次 */
(function () {
  'use strict';

  const ENDPOINT = '/api/client-error';
  const MAX_REPORTS = 6;
  const seen = Object.create(null);
  let sent = 0;

  function text(value, limit) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').slice(0, limit);
  }

  function report(kind, message, extra) {
    const detail = extra || {};
    const body = {
      kind: text(kind || 'error', 20),
      message: text(message || 'unknown error', 300),
      source: text(detail.source || '', 200),
      line: Number(detail.line) || 0,
      stack: text(detail.stack || '', 1200),
      path: location.pathname.slice(0, 120)
    };
    const key = body.kind + '|' + body.message.slice(0, 80);
    if (seen[key] || sent >= MAX_REPORTS) return false;
    seen[key] = 1;
    sent++;

    const json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return true;
      }
    } catch (e) { /* 降级到 fetch */ }

    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* 上报失败不影响页面 */ }
    return true;
  }

  // 捕获阶段能拿到图片/脚本等资源加载错误
  window.addEventListener('error', function (event) {
    const target = event.target;
    if (target && target.tagName === 'IMG') {
      report('asset', 'image load failed', { source: target.currentSrc || target.src });
      return;
    }
    report('error', event.message || 'script error', {
      source: event.filename,
      line: event.lineno,
      stack: event.error && event.error.stack
    });
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    const reason = event.reason || {};
    report('promise', reason.message || reason, { stack: reason.stack });
  });

  window.Telemetry = {
    report: report,
    count: function () { return { sent: sent, unique: Object.keys(seen).length }; }
  };
})();
