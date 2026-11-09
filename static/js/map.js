/* 地图渲染：优先高德 JS API（有 Key 时），否则使用自绘 SVG 简版地图（无 Key 可用） */
(function () {
  'use strict';

  const PALETTE = {
    bg: '#F7F0E4',
    block: '#EFE6D6',
    blockAlt: '#F2EADA',
    road: '#FBF6EC',
    route: '#FF8B45',
    routeBand: '#FFD2AA',
    store: '#FF9A56',
    spot: '#A8D8C2',
    text: '#4A3F3A',
    sub: '#9B8E86'
  };

  function hash(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function measure(text, size) {
    let width = 0;
    for (const ch of String(text)) {
      width += ch.charCodeAt(0) > 127 ? size : size * 0.56;
    }
    return width;
  }

  function project(points, width, height, padding, bottomPad) {
    const lats = points.map((p) => p[0]);
    const lngs = points.map((p) => p[1]);
    let minLat = Math.min.apply(null, lats);
    let maxLat = Math.max.apply(null, lats);
    let minLng = Math.min.apply(null, lngs);
    let maxLng = Math.max.apply(null, lngs);

    if (maxLat - minLat < 0.0015) { minLat -= 0.0008; maxLat += 0.0008; }
    if (maxLng - minLng < 0.0015) { minLng -= 0.0008; maxLng += 0.0008; }

    const pad = padding == null ? 42 : padding;
    const bottom = bottomPad || 0;
    const usableH = Math.max(80, height - bottom);
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const spanX = (maxLng - minLng) * kx;
    const spanY = maxLat - minLat;
    const scale = Math.min((width - pad * 2) / spanX, (usableH - pad * 2) / spanY);
    const cx = (minLng + maxLng) / 2;
    const cy = (minLat + maxLat) / 2;

    return function (lat, lng) {
      return [
        width / 2 + (lng - cx) * kx * scale,
        usableH / 2 - (lat - cy) * scale
      ];
    };
  }

  function escapeXml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function forkIcon(cx, cy, scale) {
    const s = scale || 1;
    return '<g transform="translate(' + cx + ',' + cy + ') scale(' + s + ')" stroke="#FFFFFF" stroke-width="1.7" ' +
      'fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M-3.4 -5.6v3.6a2 2 0 0 0 4 0v-3.6M-1.4 -2v7.6"/>' +
      '<path d="M3.6 -5.6c-1 1.2-1.3 2.4-1.3 3.9 0 1.3.5 2 1.3 2s1.3-.7 1.3-2c0-1.5-.3-2.7-1.3-3.9zM3.6 0.4v5.2"/>' +
      '</g>';
  }

  function blocks(width, height) {
    const cols = Math.max(4, Math.round(width / 78));
    const rows = Math.max(6, Math.round(height / 76));
    const cw = width / cols;
    const ch = height / rows;
    let out = '';
    for (let row = -1; row <= rows; row++) {
      for (let col = -1; col <= cols; col++) {
        const seed = row * 31 + col * 17;
        const insetX = 3 + hash(seed) * 6;
        const insetY = 3 + hash(seed + 5) * 6;
        const fill = hash(seed + 9) > 0.55 ? PALETTE.block : PALETTE.blockAlt;
        const opacity = 0.55 + hash(seed + 2) * 0.4;
        out += '<rect x="' + (col * cw + insetX).toFixed(1) + '" y="' + (row * ch + insetY).toFixed(1) +
          '" width="' + Math.max(8, cw - insetX * 2).toFixed(1) + '" height="' + Math.max(8, ch - insetY * 2).toFixed(1) +
          '" rx="7" fill="' + fill + '" opacity="' + opacity.toFixed(2) + '"/>';
      }
    }
    // 水面 / 绿地：让底图不只是色块，接近真实地图的层次
    out += '<ellipse cx="' + (width * 0.1).toFixed(1) + '" cy="' + (height * 1.02).toFixed(1) +
      '" rx="' + (width * 0.34).toFixed(1) + '" ry="' + (height * 0.16).toFixed(1) + '" fill="#DCEDF2"/>';
    out += '<rect x="' + (width * 0.64).toFixed(1) + '" y="' + (height * 0.03).toFixed(1) +
      '" width="' + (width * 0.32).toFixed(1) + '" height="' + (height * 0.2).toFixed(1) +
      '" rx="18" fill="#E3EFD9"/>';
    for (let tree = 0; tree < 5; tree++) {
      const tx = width * 0.66 + hash(tree + 3) * width * 0.26;
      const ty = height * 0.07 + hash(tree + 11) * height * 0.12;
      out += '<circle cx="' + tx.toFixed(1) + '" cy="' + ty.toFixed(1) + '" r="' +
        (3 + hash(tree) * 2).toFixed(1) + '" fill="#CBE3BC"/>';
    }

    // 主干道：先描边再铺路面，形成道路层次
    const mainRoad = 'M-20 ' + (height * 0.72) + ' Q' + (width * 0.42) + ' ' + (height * 0.52) +
      ' ' + (width + 20) + ' ' + (height * 0.2);
    out += '<path d="' + mainRoad + '" stroke="#E3D7C4" stroke-width="22" fill="none" stroke-linecap="round"/>';
    out += '<path d="' + mainRoad + '" stroke="' + PALETTE.road + '" stroke-width="16" fill="none" stroke-linecap="round"/>';
    out += '<path d="' + mainRoad + '" stroke="#EFE0C9" stroke-width="1.4" stroke-dasharray="10 14" fill="none"/>';

    const sideRoad = 'M' + (width * 0.18) + ' -10 Q' + (width * 0.34) + ' ' + (height * 0.55) +
      ' ' + (width * 0.12) + ' ' + (height + 10);
    out += '<path d="' + sideRoad + '" stroke="#E3D7C4" stroke-width="15" fill="none" stroke-linecap="round"/>';
    out += '<path d="' + sideRoad + '" stroke="' + PALETTE.road + '" stroke-width="10" fill="none" stroke-linecap="round"/>';
    return out;
  }

  function svgMap(el, options) {
    const opts = options || {};
    const width = el.clientWidth || 390;
    const height = el.clientHeight || 320;
    const store = opts.store;
    const me = opts.me;
    const spots = opts.spots || [];
    const route = opts.route;

    const raw = [];
    if (store) raw.push([store.lat, store.lng]);
    if (me) raw.push([me.lat, me.lng]);
    spots.forEach((s) => raw.push([s.lat, s.lng]));
    (route || []).forEach((p) => raw.push([p[0], p[1]]));
    if (!raw.length) return;

    const projectPoint = project(raw, width, height, opts.padding == null ? 44 : opts.padding, opts.paddingBottom || 0);
    const storeXY = store ? projectPoint(store.lat, store.lng) : null;
    const meXY = me ? projectPoint(me.lat, me.lng) : null;

    // 标签避让：先登记所有标记占位，再为每个标签挑选重叠面积最小的候选位置
    const boxes = [];
    const reserve = (x, y, w, h) => boxes.push({ x: x, y: y, w: w, h: h });
    const placeLabel = (px, py, text, opts) => {
      const size = (opts && opts.size) || 11;
      const w = measure(text, size) + 16;
      const h = 21;
      const candidates = [
        [px + 18, py - h / 2],
        [px - 18 - w, py - h / 2],
        [px - w / 2, py - 30],
        [px - w / 2, py + 10]
      ];
      let best = null;
      let bestOverlap = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const x = Math.max(4, Math.min(width - w - 4, candidates[i][0]));
        const y = Math.max(8, Math.min(height - h - 8, candidates[i][1]));
        let overlap = 0;
        for (const b of boxes) {
          const ox = Math.min(x + w, b.x + b.w) - Math.max(x, b.x);
          const oy = Math.min(y + h, b.y + b.h) - Math.max(y, b.y);
          if (ox > 0 && oy > 0) overlap += ox * oy;
        }
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          best = [x, y];
          if (overlap === 0) break;
        }
      }
      const bx = best[0];
      const by = best[1];
      reserve(bx, by, w, h);
      return '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + w.toFixed(1) +
        '" height="' + h + '" rx="7" fill="#FFFFFF" opacity="0.96"/>' +
        '<text x="' + (bx + 8).toFixed(1) + '" y="' + (by + 15).toFixed(1) +
        '" font-size="' + size + '" fill="' + ((opts && opts.color) || PALETTE.text) + '" font-weight="600">' +
        escapeXml(text) + '</text>';
    };
    const labelQueue = [];
    let featuredAnchor = null;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="100%" ' +
      'preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">';
    svg += '<rect width="' + width + '" height="' + height + '" fill="' + PALETTE.bg + '"/>';
    svg += blocks(width, height);

    // 路线（先画特色街巷宽光带，再画主线）
    if (route && route.length > 1) {
      const path = route.map((p, i) => {
        const xy = projectPoint(p[0], p[1]);
        return (i === 0 ? 'M' : 'L') + xy[0].toFixed(1) + ' ' + xy[1].toFixed(1);
      }).join(' ');

      if (opts.featuredSegment != null && route[opts.featuredSegment + 1]) {
        const idx = Math.max(0, opts.featuredSegment);
        const a = projectPoint(route[idx][0], route[idx][1]);
        const b = projectPoint(route[idx + 1][0], route[idx + 1][1]);
        svg += '<path d="M' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + 'L' + b[0].toFixed(1) + ' ' + b[1].toFixed(1) +
          '" stroke="' + PALETTE.routeBand + '" stroke-width="24" stroke-linecap="round" opacity="0.95"/>';
        if (opts.featuredLabel) {
          featuredAnchor = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        }
      }

      svg += '<path d="' + path + '" stroke="#FFFFFF" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>';
      svg += '<path d="' + path + '" stroke="' + PALETTE.route + '" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
    }

    // 游玩点位（可点击看详情）
    const spotPoints = [];
    spots.forEach((spot, index) => {
      const xy = projectPoint(spot.lat, spot.lng);
      spotPoints.push({ x: xy[0], y: xy[1], name: spot.name, index: index });
      reserve(xy[0] - 9, xy[1] - 9, 18, 18);
      svg += '<g class="map-spot-hit" data-index="' + index + '" style="cursor:pointer">' +
        '<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="15" fill="transparent"/>' +
        '<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="9" fill="#FFFFFF" opacity="0.9"/>' +
        '<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="6" fill="' + PALETTE.spot + '"/>' +
        '</g>';
    });

    // 我的位置
    if (meXY) {
      reserve(meXY[0] - 13, meXY[1] - 13, 26, 26);
      svg += '<circle class="map-me-ring" cx="' + meXY[0].toFixed(1) + '" cy="' + meXY[1].toFixed(1) +
        '" r="14" fill="none" stroke="' + PALETTE.spot + '" stroke-width="2" opacity="0.6"/>';
      svg += '<circle cx="' + meXY[0].toFixed(1) + '" cy="' + meXY[1].toFixed(1) + '" r="11" fill="#FFFFFF"/>';
      svg += '<circle cx="' + meXY[0].toFixed(1) + '" cy="' + meXY[1].toFixed(1) + '" r="7.5" fill="' + PALETTE.spot + '"/>';
    }

    // 餐饮点
    if (storeXY) {
      reserve(storeXY[0] - 17, storeXY[1] - 17, 34, 34);
      svg += '<circle cx="' + storeXY[0].toFixed(1) + '" cy="' + storeXY[1].toFixed(1) + '" r="19" fill="' + PALETTE.store + '" opacity="0.16"/>';
      svg += '<circle cx="' + storeXY[0].toFixed(1) + '" cy="' + storeXY[1].toFixed(1) + '" r="14" fill="' + PALETTE.store + '" stroke="#FFFFFF" stroke-width="3"/>';
      svg += forkIcon(storeXY[0], storeXY[1], 1);
    }

    // 标签优先级：餐饮点 > 特色街巷 > 我的位置 > 前两个游玩点
    if (storeXY && opts.showStoreLabel !== false) {
      labelQueue.push({ x: storeXY[0], y: storeXY[1], text: store.name || '这家店', opts: { size: 11 } });
    }
    if (featuredAnchor) {
      labelQueue.push({ x: featuredAnchor[0], y: featuredAnchor[1], text: opts.featuredLabel, opts: { size: 10, color: '#B87333' } });
    }
    if (meXY && opts.showMeLabel) {
      labelQueue.push({ x: meXY[0], y: meXY[1], text: '我的位置', opts: { size: 10, color: '#4E9C7E' } });
    }
    if (opts.showSpotLabels) {
      const limit = opts.spotLabelLimit == null ? 99 : opts.spotLabelLimit;
      spotPoints.slice(0, limit).forEach((point) => {
        labelQueue.push({ x: point.x, y: point.y, text: point.name, opts: { size: 10 } });
      });
    }
    labelQueue.forEach((item) => { svg += placeLabel(item.x, item.y, item.text, item.opts); });

    svg += '</svg>';
    el.innerHTML = svg + '<span class="map-attrib">示意底图 · 仅表示相对位置</span>';
    const pan = bindPanZoom(el, { min: 1, max: 3.2 });
    el.querySelectorAll('.map-spot-hit').forEach(function (node) {
      node.addEventListener('click', function (event) {
        if (pan.dragged()) { event.preventDefault(); return; }
        const index = Number(node.getAttribute('data-index'));
        if (spots[index] && opts.onSpot) opts.onSpot(spots[index]);
      });
    });
    el.dataset.zoom = '1';
    return {
      real: false,
      zoom: pan.zoom,
      reset: pan.reset,
      destroy: pan.destroy,
      dragged: pan.dragged
    };
  }

  /* ---------------- SVG 底图的平移 / 缩放（拖拽、滚轮、双指、双击） ---------------- */
  function bindPanZoom(el, options) {
    const opts = options || {};
    const minScale = opts.min == null ? 1 : opts.min;
    const maxScale = opts.max == null ? 3.2 : opts.max;
    const svg = el.querySelector('svg');
    if (!svg) {
      return { zoom: function () {}, reset: function () {}, destroy: function () {}, dragged: function () { return false; } };
    }
    el.style.touchAction = 'none';
    svg.style.transformOrigin = '50% 50%';
    svg.style.willChange = 'transform';

    const state = { scale: 1, tx: 0, ty: 0 };
    let dragged = false;
    const pointers = new Map();
    let pinchStart = 0;
    let pinchScale = 1;

    function apply(animate) {
      svg.style.transition = animate ? 'transform .18s ease' : 'none';
      svg.style.transform = 'translate(' + state.tx.toFixed(1) + 'px,' + state.ty.toFixed(1) + 'px) scale(' + state.scale + ')';
    }

    function clampPan() {
      const maxX = (el.clientWidth * (state.scale - 1)) / 2;
      const maxY = (el.clientHeight * (state.scale - 1)) / 2;
      state.tx = Math.max(-maxX, Math.min(maxX, state.tx));
      state.ty = Math.max(-maxY, Math.min(maxY, state.ty));
    }

    function zoomAt(clientX, clientY, factor) {
      const rect = el.getBoundingClientRect();
      const next = Math.max(minScale, Math.min(maxScale, state.scale * factor));
      if (next === state.scale) return;
      const k = next / state.scale;
      const ox = clientX - rect.left - rect.width / 2;
      const oy = clientY - rect.top - rect.height / 2;
      state.tx = ox - k * (ox - state.tx);
      state.ty = oy - k * (oy - state.ty);
      state.scale = next;
      clampPan();
      apply(true);
    }

    function onPointerDown(event) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      dragged = false;
      svg.style.transition = 'none';
      if (el.setPointerCapture) {
        try { el.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
      }
      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
        pinchScale = state.scale;
      }
    }

    function onPointerMove(event) {
      const point = pointers.get(event.pointerId);
      if (!point) return;
      const dx = event.clientX - point.x;
      const dy = event.clientY - point.y;
      point.x = event.clientX;
      point.y = event.clientY;

      if (pointers.size >= 2) {
        const [a, b] = Array.from(pointers.values());
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStart > 0) {
          const next = Math.max(minScale, Math.min(maxScale, pinchScale * (distance / pinchStart)));
          state.scale = next;
          clampPan();
          apply(false);
        }
        dragged = true;
        return;
      }

      if (Math.abs(dx) + Math.abs(dy) > 1) dragged = true;
      state.tx += dx;
      state.ty += dy;
      clampPan();
      apply(false);
    }

    function onPointerUp(event) {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchStart = 0;
      if (!pointers.size) {
        apply(true);
        // click 紧跟在 pointerup 之后触发：延后一拍再清标记，既不误吞点击，也不残留「刚拖过」
        setTimeout(function () { dragged = false; }, 0);
      }
    }

    function onWheel(event) {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.88 : 1.14);
    }

    function onDoubleClick(event) {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, 1.5);
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('pointerleave', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDoubleClick);

    return {
      zoom: function (delta) {
        const rect = el.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 + (delta || 0) * 0.3);
      },
      reset: function () {
        state.scale = 1;
        state.tx = 0;
        state.ty = 0;
        apply(true);
      },
      dragged: function () { return dragged; },
      destroy: function () {
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerup', onPointerUp);
        el.removeEventListener('pointercancel', onPointerUp);
        el.removeEventListener('pointerleave', onPointerUp);
        el.removeEventListener('wheel', onWheel);
        el.removeEventListener('dblclick', onDoubleClick);
      }
    };
  }

  /* 兼容旧调用：直接对元素做一次缩放 */
  function svgZoom(el, delta) {
    const inst = el && el.querySelector('svg');
    if (!inst) return;
    const current = parseFloat(el.dataset.zoom || '1');
    const next = Math.max(1, Math.min(1.8, current + delta));
    el.dataset.zoom = String(next);
    inst.style.transition = 'transform .28s ease';
    inst.style.transformOrigin = '50% 50%';
    inst.style.transform = 'scale(' + next + ')';
  }

  /* ---------------- 高德 JS API（可选） ---------------- */
  let amapPromise = null;
  function loadAMap() {
    if (amapPromise) return amapPromise;
    const key = (App.boot.map && App.boot.map.amapJsKey) || '';
    if (!key) return Promise.reject(new Error('no key'));
    // 高德 JS API 2.0 需要安全密钥，必须在 SDK 加载前设置
    const security = (App.boot.map && App.boot.map.amapSecurityCode) || '';
    if (security) {
      window._AMapSecurityConfig = { securityJsCode: security };
    }
    amapPromise = new Promise((resolve, reject) => {
      window.__onAMapReady = function () { resolve(window.AMap); };
      const script = document.createElement('script');
      script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(key) + '&callback=__onAMapReady';
      script.onerror = function () { reject(new Error('amap load failed')); };
      document.head.appendChild(script);
      setTimeout(() => reject(new Error('amap timeout')), 8000);
    });
    return amapPromise;
  }

  /* 高德中心点必须是有效坐标：store 可能是空对象（详情还没就绪），不能直接取 lng/lat */
  function safeCenter(store) {
    const lng = Number(store && store.lng);
    const lat = Number(store && store.lat);
    if (isFinite(lng) && isFinite(lat) && lng !== 0 && lat !== 0) return [lng, lat];
    return [116.4703, 39.9963];
  }

  async function amapRender(el, options) {
    const AMap = await loadAMap();
    const opts = options || {};
    const center = safeCenter(opts.store);
    el.innerHTML = ''; // 清掉「地图加载中」占位，避免和高德容器叠加
    const map = new AMap.Map(el, {
      zoom: 15,
      center: center,
      mapStyle: 'amap://styles/whitesmoke',
      showLabel: true,
      resizeEnable: true
    });
    if (opts.route && opts.route.length > 1) {
      new AMap.Polyline({
        path: opts.route.map((p) => [p[1], p[0]]),
        strokeColor: '#FF8B45',
        strokeWeight: 6,
        lineJoin: 'round',
        lineCap: 'round',
        map: map
      });
    }
    const markers = [];
    if (opts.me) {
      markers.push(new AMap.Marker({
        position: [opts.me.lng, opts.me.lat],
        content: '<div style="width:14px;height:14px;border-radius:50%;background:#A8D8C2;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.2)"></div>',
        offset: new AMap.Pixel(-7, -7),
        map: map
      }));
    }
    if (opts.store) {
      markers.push(new AMap.Marker({
        position: [opts.store.lng, opts.store.lat],
        content: '<div style="width:30px;height:30px;border-radius:50%;background:#FF9A56;border:3px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;box-shadow:0 3px 10px rgba(255,154,86,.4)">🍴</div>',
        offset: new AMap.Pixel(-15, -15),
        map: map
      }));
    }
    (opts.spots || []).forEach((spot) => {
      const marker = new AMap.Marker({
        position: [spot.lng, spot.lat],
        content: '<div style="width:12px;height:12px;border-radius:50%;background:#A8D8C2;border:2.5px solid #fff"></div>',
        offset: new AMap.Pixel(-6, -6),
        map: map
      });
      if (opts.onSpot) marker.on('click', function () { opts.onSpot(spot); });
      markers.push(marker);
    });
    map.add(markers);
    try { map.setFitView(markers, false, 60); } catch (e) { /* 忽略 */ }
    try { map.addControl(new AMap.Scale()); } catch (e) { /* 忽略 */ }
    try { map.addControl(new AMap.ToolBar({ position: { top: '58px', right: '12px' } })); } catch (e) { /* 忽略 */ }

    // 缩放级别自己记账：getZoom() 在地图 complete 前可能拿不到值
    let zoomLevel = Number(opts.zoom) || 15;
    const syncZoom = function () {
      const current = map.getZoom();
      if (typeof current === 'number' && !isNaN(current)) zoomLevel = current;
      el.dataset.zoomLevel = String(zoomLevel);
    };
    try {
      map.on('zoomend', syncZoom);
      map.on('complete', function () {
        // 容器在页面切换动画中可能还是 0 尺寸，完成后再量一次
        try { map.resize(); } catch (e) { /* 忽略 */ }
        syncZoom();
      });
      syncZoom();
    } catch (e) { /* 忽略 */ }

    return {
      map: map,
      real: true,
      zoom: function (delta) {
        zoomLevel = Math.max(3, Math.min(20, zoomLevel + (delta || 0) * 1.6));
        try {
          map.setZoom(zoomLevel);
        } catch (e) {
          // 容器尺寸在初始化时为 0 会让内部 center 变成 NaN，退回「设级别 + 给中心点」
          try { map.setZoomAndCenter(zoomLevel, center); } catch (err) { /* 忽略 */ }
        }
        el.dataset.zoomLevel = String(zoomLevel);
      },
      reset: function () {
        try { map.setFitView(markers, false, 60); } catch (e) { /* 忽略 */ }
        syncZoom();
      },
      destroy: function () { try { map.destroy(); } catch (e) { /* 忽略 */ } }
    };
  }

  /* ---------------- 定位场景：我的位置 + 周边地标 ---------------- */
  const LOCATE_KIND_ICON = {
    '地铁': 'M', '公交': 'B', '商场': 'S', '公园': 'P', '景点': 'A', '地标': 'L'
  };

  function haversineJs(lat1, lng1, lat2, lng2) {
    const R = 6371008.8;
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = p2 - p1;
    const dl = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  async function amapLocate(el, options) {
    const AMap = await loadAMap();
    const opts = options || {};
    const me = opts.me;
    const landmarks = opts.landmarks || [];
    const onPick = opts.onPick || function () {};
    const here = safeCenter(me);

    el.innerHTML = '';
    const map = new AMap.Map(el, {
      zoom: opts.zoom || 16,
      center: here,
      mapStyle: 'amap://styles/whitesmoke',
      resizeEnable: true,
      showLabel: true,
      viewMode: '2D'
    });

    // 我的位置：呼吸圆点
    const meMarker = new AMap.Marker({
      position: [me.lng, me.lat],
      content: '<div class="map-me-pin"><span class="map-me-pulse"></span><span class="map-me-core"></span></div>',
      offset: new AMap.Pixel(-11, -11),
      zIndex: 300,
      map: map
    });

    // 周边地标：点击查看详情
    const markers = landmarks.map(function (lm) {
      const marker = new AMap.Marker({
        position: [lm.lng, lm.lat],
        content: '<div class="map-lm-pin" data-kind="' + escapeXml(lm.kind || '地标') + '">' +
          '<span class="map-lm-ico">' + escapeXml(LOCATE_KIND_ICON[lm.kind] || 'L') + '</span>' +
          '<i class="map-lm-name">' + escapeXml(lm.name || '') + '</i></div>',
        offset: new AMap.Pixel(-10, -10),
        zIndex: 200,
        map: map
      });
      marker.on('click', function () { onPick(lm); });
      return marker;
    });

    // 比例尺 + 缩放控件；拖动/滚轮缩放由地图默认支持
    try { map.addControl(new AMap.Scale()); } catch (e) { /* 忽略 */ }
    try { map.addControl(new AMap.ToolBar({ position: { top: '58px', right: '12px' } })); } catch (e) { /* 忽略 */ }

    map.setFitView([meMarker].concat(markers), false, [70, 70, 70, 90]);
    let zoomLevel = Number(opts.zoom) || 16;
    const syncZoom = function () {
      const current = map.getZoom();
      if (typeof current === 'number' && !isNaN(current)) zoomLevel = current;
      el.dataset.zoomLevel = String(zoomLevel);
    };
    try {
      map.on('zoomend', syncZoom);
      map.on('complete', function () {
        // 容器在页面切换动画中可能还是 0 尺寸，完成后再量一次
        try { map.resize(); } catch (e) { /* 忽略 */ }
        syncZoom();
      });
      syncZoom();
    } catch (e) { /* 忽略 */ }

    return {
      real: true,
      map: map,
      zoom: function (delta) {
        zoomLevel = Math.max(3, Math.min(20, zoomLevel + (delta || 0) * 1.6));
        try {
          map.setZoom(zoomLevel);
        } catch (e) {
          try { map.setZoomAndCenter(zoomLevel, here); } catch (err) { /* 忽略 */ }
        }
        el.dataset.zoomLevel = String(zoomLevel);
      },
      reset: function () {
        try { map.setFitView([meMarker].concat(markers), false, [70, 70, 70, 90]); } catch (e) { /* 忽略 */ }
        syncZoom();
      },
      destroy: function () { try { map.destroy(); } catch (e) { /* 忽略 */ } }
    };
  }

  function svgLocate(el, options) {
    const opts = options || {};
    const me = opts.me;
    const landmarks = opts.landmarks || [];
    const onPick = opts.onPick || function () {};
    const width = el.clientWidth || 360;
    const height = el.clientHeight || 260;

    const raw = [[me.lat, me.lng]].concat(landmarks.map(function (lm) { return [lm.lat, lm.lng]; }));
    const projectPoint = project(raw, width, height, 52);
    const meXY = projectPoint(me.lat, me.lng);

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="100%" ' +
      'preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">';
    svg += '<rect width="' + width + '" height="' + height + '" fill="' + PALETTE.bg + '"/>';
    svg += blocks(width, height);

    // 地标：连线 + 可点击热点
    landmarks.forEach(function (lm, index) {
      const xy = projectPoint(lm.lat, lm.lng);
      const dist = Math.round(haversineJs(me.lat, me.lng, lm.lat, lm.lng));
      svg += '<line x1="' + meXY[0].toFixed(1) + '" y1="' + meXY[1].toFixed(1) + '" x2="' + xy[0].toFixed(1) +
        '" y2="' + xy[1].toFixed(1) + '" stroke="#E9D8C4" stroke-width="1.4" stroke-dasharray="4 4"/>';
      svg += '<g class="map-lm-hit" data-index="' + index + '" style="cursor:pointer">' +
        '<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="14" fill="transparent"/>' +
        '<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="7" fill="#FF9A56" stroke="#fff" stroke-width="2.5"/>' +
        '<text x="' + xy[0].toFixed(1) + '" y="' + (xy[1] - 12).toFixed(1) + '" text-anchor="middle" font-size="10" fill="' +
        PALETTE.text + '" font-weight="600">' + escapeXml(lm.name) + '</text>' +
        '<text x="' + xy[0].toFixed(1) + '" y="' + (xy[1] + 22).toFixed(1) + '" text-anchor="middle" font-size="9" fill="' +
        PALETTE.sub + '">' + escapeXml((lm.kind || '') + ' · ' + dist + 'm') + '</text>' +
        '</g>';
    });

    // 我的位置
    svg += '<circle class="map-me-ring" cx="' + meXY[0].toFixed(1) + '" cy="' + meXY[1].toFixed(1) +
      '" r="16" fill="none" stroke="' + PALETTE.spot + '" stroke-width="2" opacity="0.6"/>';
    svg += '<circle cx="' + meXY[0].toFixed(1) + '" cy="' + meXY[1].toFixed(1) + '" r="12" fill="#fff"/>';
    svg += '<circle cx="' + meXY[0].toFixed(1) + '" cy="' + meXY[1].toFixed(1) + '" r="8" fill="' + PALETTE.spot + '"/>';
    svg += '<text x="' + meXY[0].toFixed(1) + '" y="' + (meXY[1] + 30).toFixed(1) +
      '" text-anchor="middle" font-size="10" fill="#4E9C7E" font-weight="700">我的位置</text>';
    svg += '</svg>';

    el.innerHTML = svg + '<span class="map-attrib">示意底图 · 仅表示相对位置</span>';

    // ---- 交互：拖动平移 + 滚轮/双指/按钮缩放 + 点击标记（拖动后不误触） ----
    const pan = bindPanZoom(el, { min: 1, max: 3.2 });

    el.querySelectorAll('.map-lm-hit').forEach(function (node) {
      node.addEventListener('click', function (event) {
        if (pan.dragged()) { event.preventDefault(); return; }
        const index = Number(node.getAttribute('data-index'));
        if (landmarks[index]) onPick(landmarks[index]);
      });
    });

    return {
      real: false,
      zoom: pan.zoom,
      reset: pan.reset,
      destroy: pan.destroy
    };
  }

  /* 每个容器只保留一个地图实例：重渲染先销毁旧的，避免高德 canvas 越叠越多 */
  const instances = new WeakMap();

  function destroyInstance(el) {
    const prev = el && instances.get(el);
    if (prev && prev.destroy) {
      try { prev.destroy(); } catch (e) { /* 忽略 */ }
    }
    if (el) {
      instances.delete(el);
      el.innerHTML = '';
      delete el.dataset.zoomLevel;
      // 作废还在路上的异步创建，避免快速切换时留下孤儿地图
      el.dataset.mapSeq = String(Number(el.dataset.mapSeq || 0) + 1);
    }
  }

  function makeHandle(el, inner) {
    return {
      real: !!(inner && inner.real),
      zoom: function (delta) { if (inner && inner.zoom) inner.zoom(delta); },
      reset: function () { if (inner && inner.reset) inner.reset(); },
      destroy: function () {
        if (inner && inner.destroy) inner.destroy();
        if (el) el.innerHTML = '';
      }
    };
  }

  const MapView = {
    render(el, options) {
      if (!el) return null;
      const opts = options || {};
      destroyInstance(el);
      let inner = null;
      // 句柄先建好：高德异步加载失败时自动降级为 SVG，调用方拿到的 zoom/reset 仍然有效
      const handle = {
        real: false,
        zoom: function (delta) { if (inner && inner.zoom) inner.zoom(delta); },
        reset: function () { if (inner && inner.reset) inner.reset(); },
        destroy: function () {
          if (inner && inner.destroy) inner.destroy();
          el.innerHTML = '';
        }
      };
      instances.set(el, handle);
      const seq = String(Number(el.dataset.mapSeq || 0) + 1);
      el.dataset.mapSeq = seq;
      if (App.boot.map && App.boot.map.amapJsKey) {
        el.innerHTML = '<div class="map-loading">地图加载中…</div>';
        amapRender(el, opts).then(function (result) {
          if (el.dataset.mapSeq !== seq) { if (result.destroy) result.destroy(); return; }
          inner = result;
          handle.real = true;
        }).catch(function () {
          if (el.dataset.mapSeq !== seq) return;
          inner = svgMap(el, opts);
          handle.real = false;
        });
      } else {
        inner = svgMap(el, opts);
      }
      return handle;
    },

    /** 兼容旧入口：按容器找到当前实例再缩放；没有实例则退化为直接缩放 SVG */
    zoom(el, delta) {
      if (!el) return;
      const inst = instances.get(el);
      if (inst && inst.zoom) inst.zoom(delta);
      else svgZoom(el, delta);
    },

    /** 回到初始视野（高德 fitView / SVG 复位） */
    reset(el) {
      if (!el) return;
      const inst = instances.get(el);
      if (inst && inst.reset) inst.reset();
    },

    svgMap: svgMap,

    /** 定位场景：我的位置 + 周边地标；有 Key 用高德（可缩放拖动点标记），否则 SVG */
    renderLocate(el, options) {
      if (!el) return null;
      const opts = options || {};
      destroyInstance(el);
      let inner = null;
      const handle = makeHandle(el, null);
      handle.zoom = function (delta) { if (inner && inner.zoom) inner.zoom(delta); };
      handle.reset = function () { if (inner && inner.reset) inner.reset(); };
      handle.destroy = function () {
        if (inner && inner.destroy) inner.destroy();
        el.innerHTML = '';
      };
      instances.set(el, handle);
      const seq = String(Number(el.dataset.mapSeq || 0) + 1);
      el.dataset.mapSeq = seq;
      if (App.boot.map && App.boot.map.amapJsKey) {
        el.innerHTML = '<div class="map-loading">地图加载中…</div>';
        amapLocate(el, opts).then(function (result) {
          if (el.dataset.mapSeq !== seq) { if (result.destroy) result.destroy(); return; }
          inner = result;
          handle.real = true;
        }).catch(function () {
          if (el.dataset.mapSeq !== seq) return;
          inner = svgLocate(el, opts);
          handle.real = false;
        });
      } else {
        inner = svgLocate(el, opts);
      }
      return handle;
    }
  };

  window.MapView = MapView;
})();
