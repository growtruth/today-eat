/* 接口封装：统一超时、可取消、友好错误、JSON 解析兜底；GET 与写操作共用一套错误处理 */
(function () {
  'use strict';

  function qs(params) {
    const parts = [];
    Object.keys(params || {}).forEach((key) => {
      const value = params[key];
      if (value === undefined || value === null || value === '') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function friendlyError(message, code, hint) {
    const error = new Error(message);
    error.code = code;
    error.hint = hint;
    return error;
  }

  async function parse(response) {
    let data = null;
    try {
      data = await response.json();
    } catch (parseError) {
      throw friendlyError(
        response.ok ? '返回内容异常，再试一次？' : '服务暂时不可用（' + response.status + '）',
        'bad_response'
      );
    }
    if (!data || data.ok === false) {
      throw friendlyError(
        (data && data.message) || '数据没拉到',
        (data && data.code) || 'api_error',
        data && data.hint
      );
    }
    return data;
  }

  async function run(path, init, options) {
    const opts = options || {};
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, opts.timeout || 9000);

    const external = opts.signal;
    let relay = null;
    if (external) {
      if (external.aborted) controller.abort();
      else {
        relay = function () { controller.abort(); };
        external.addEventListener('abort', relay, { once: true });
      }
    }

    try {
      const response = await fetch(path, Object.assign({
        signal: controller.signal,
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      }, init));
      return await parse(response);
    } catch (error) {
      if (error.name === 'AbortError') {
        if (timedOut) throw friendlyError('网络有点慢，再试一次？', 'timeout');
        throw friendlyError('请求已取消', 'aborted');
      }
      if (error instanceof TypeError) {
        // fetch 网络层失败（断网、DNS、跨域）
        throw friendlyError('网络好像断了，检查一下连接', 'network');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (external && relay) external.removeEventListener('abort', relay);
    }
  }

  function reportFailure(path, error) {
    if (!window.Telemetry || path.indexOf('/api/client-error') === 0) return;
    const code = error && error.code;
    if (code !== 'server_error' && code !== 'network' && code !== 'timeout' && code !== 'bad_response') return;
    window.Telemetry.report('api', (error && error.message) || 'api failed', {
      source: path.split('?')[0]
    });
  }

  async function request(path, params, options) {
    const full = path + qs(params);
    try {
      return await run(full, { method: 'GET' }, options);
    } catch (error) {
      reportFailure(full, error);
      throw error;
    }
  }

  async function send(method, path, body, options) {
    try {
      return await run(path, {
        method: method,
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }, options);
    } catch (error) {
      reportFailure(path, error);
      throw error;
    }
  }

  window.API = {
    request: request,
    send: send,
    bootstrap: () => request('/api/bootstrap'),
    restaurants: (params, options) => request('/api/restaurants', params, Object.assign({ timeout: 12000 }, options)),
    detail: (id, options) => request('/api/restaurant/' + encodeURIComponent(id), null, Object.assign({ timeout: 10000 }, options)),
    route: (params) => request('/api/route', params, { timeout: 12000 }),
    playSpots: (params) => request('/api/play-spots', params, { timeout: 10000 }),
    geocode: (q, city) => request('/api/geocode', { q: q, city: city }, { timeout: 10000 }),
    regeo: (lat, lng) => request('/api/regeo', { lat: lat, lng: lng }, { timeout: 8000 }),
    ipLocate: () => request('/api/ip-locate', null, { timeout: 8000 }),
    locateContext: (lat, lng, radius) => request('/api/locate-context', { lat: lat, lng: lng, radius: radius }, { timeout: 18000 }),
    areas: (city) => request('/api/areas', { city: city }),
    sources: (active) => request('/api/sources', { active: active }),

    /* ---------------- 身份与社交 ---------------- */
    authDevice: (deviceId, nickname) => send('POST', '/api/auth/device', { deviceId: deviceId, nickname: nickname || '' }),
    me: () => request('/api/me'),
    authCloud: (token, deviceId) => send('POST', '/api/auth/cloud', { token: token, deviceId: deviceId || '' }),
    logout: () => send('POST', '/api/auth/logout'),
    buddies: () => request('/api/buddies'),
    addBuddy: (payload) => send('POST', '/api/buddies', payload),
    updateBuddy: (id, payload) => send('PATCH', '/api/buddies/' + encodeURIComponent(id), payload),
    deleteBuddy: (id) => send('DELETE', '/api/buddies/' + encodeURIComponent(id)),
    drawBuddy: (payload) => send('POST', '/api/buddies/draw', payload),
    createInvite: (inviteeName) => send('POST', '/api/invites', { inviteeName: inviteeName || '' }),
    inviteInfo: (token) => request('/api/invites/' + encodeURIComponent(token)),
    acceptInvite: (token) => send('POST', '/api/invites/' + encodeURIComponent(token) + '/accept'),
    revokeInvite: (token) => send('DELETE', '/api/invites/' + encodeURIComponent(token)),

    /* ---------------- 团购与骰子 ---------------- */
    deals: (params) => request('/api/deals', params, { timeout: 8000 }),
    dice: (buddyId) => send('POST', '/api/dice', { buddyId: buddyId }),
    diceHistory: (limit) => request('/api/dice/history', { limit: limit || 10 })
  };
})();
