/* 美食雷达：把当前筛选结果按「方位角 + 直线距离」铺到雷达图上，支持点选与加权扫描 */
(function () {
  'use strict';

  const CX = 170;
  const CY = 170;
  const R = 142;
  const STEP_CHOICES = [500, 1000, 2000, 3000];

  const CUISINE_COLOR = {
    火锅: '#E2703A', 日料: '#5B8FB9', 烧烤: '#C4703F', 甜品: '#D98BA8',
    咖啡: '#9C7B5A', 奶茶: '#C99A6B', 小吃: '#7BA05B', 川菜: '#C2453F',
    西餐: '#8B6F9E', 中餐: '#B8874B'
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function colorOf(cuisine) {
    return CUISINE_COLOR[cuisine] || '#B08A6A';
  }

  function kmLabel(meters) {
    const value = meters / 1000;
    return (Math.abs(value - Math.round(value)) < 0.05 ? value.toFixed(0) : value.toFixed(1)) + 'km';
  }

  const Radar = {
    layer: null,
    selectedId: null,
    pickedId: null,
    itemsSorted: [],
    scanning: false,
    scanTimer: null,

    init() {
      this.layer = document.getElementById('radarLayer');
      if (!this.layer) return;
      const self = this;

      const entry = document.getElementById('radarBtn');
      if (entry) entry.addEventListener('click', () => self.open());

      const close = document.getElementById('radarClose');
      if (close) close.addEventListener('click', () => self.close());

      const scan = document.getElementById('radarScan');
      if (scan) scan.addEventListener('click', () => self.scan());

      const stage = document.getElementById('radarStage');
      if (stage) {
        stage.addEventListener('click', function (event) {
          const blip = event.target.closest('[data-radar-id]');
          if (blip) self.select(blip.dataset.radarId);
        });
        stage.addEventListener('keydown', function (event) {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
          const blip = event.target.closest('[data-radar-id]');
          if (!blip) return;
          event.preventDefault();
          self.select(blip.dataset.radarId);
        });
      }

      const panel = document.getElementById('radarPanel');
      if (panel) {
        panel.addEventListener('click', function (event) {
          if (event.target.closest('#radarDetailBtn')) self.goDetail();
        });
      }
    },

    /* ---------------- 数据 ---------------- */

    items() {
      const list = Array.isArray(Feed.filtered) ? Feed.filtered : (Feed.items || []);
      return list.filter((item) => item &&
        typeof item.lat === 'number' && typeof item.lng === 'number');
    },

    center() {
      const loc = App.state.location || App.boot.defaults || {};
      return {
        lat: Number(loc.lat) || 39.9963,
        lng: Number(loc.lng) || 116.4703,
        label: loc.label || ''
      };
    },

    distanceOf(item) {
      if (typeof item.distance === 'number' && isFinite(item.distance)) return Math.max(0, item.distance);
      return this.haversine(this.center(), item);
    },

    haversine(from, to) {
      const rad = Math.PI / 180;
      const dLat = (to.lat - from.lat) * rad;
      const dLng = (to.lng - from.lng) * rad;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(from.lat * rad) * Math.cos(to.lat * rad) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
    },

    bearingOf(item) {
      const from = this.center();
      const rad = Math.PI / 180;
      const lat1 = from.lat * rad;
      const lat2 = item.lat * rad;
      const dLng = (item.lng - from.lng) * rad;
      const y = Math.sin(dLng) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
      return (Math.atan2(y, x) / rad + 360) % 360;
    },

    directionLabel(deg) {
      const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
      return names[Math.round(deg / 45) % 8];
    },

    formatDistance(meters) {
      if (meters < 1000) return Math.round(meters / 10) * 10 + 'm';
      return (meters / 1000).toFixed(1) + 'km';
    },

    /** 根据最远门店挑选一个整齐的环距：保证 3 环覆盖全部点位 */
    stepFor(maxDistance) {
      const need = Math.max(maxDistance, 600) / 3;
      return STEP_CHOICES.find((step) => step >= need) || 3000;
    },

    metrics(items) {
      const distances = items.map((item) => this.distanceOf(item));
      const maxDistance = distances.length ? Math.max.apply(null, distances) : 0;
      const step = this.stepFor(maxDistance);
      // 累计计数：「2km 内」应包含 1km 内的店，和用户的直觉一致
      const counts = [0, 0, 0];
      distances.forEach((distance) => {
        if (distance <= step) counts[0]++;
        if (distance <= step * 2) counts[1]++;
        if (distance <= step * 3) counts[2]++;
      });
      return { step: step, outer: step * 3, counts: counts, maxDistance: maxDistance };
    },

    /* ---------------- 渲染 ---------------- */

    render() {
      const items = this.items();
      this.itemsSorted = items.slice().sort((a, b) => this.distanceOf(a) - this.distanceOf(b));
      if (!this.itemsSorted.some((item) => item.id === this.selectedId)) this.selectedId = null;
      if (!this.itemsSorted.some((item) => item.id === this.pickedId)) this.pickedId = null;

      this.renderStage(items);
      this.renderSummary(items);
      this.renderCard();
    },

    renderSummary(items) {
      const util = App.util;
      const metrics = this.metrics(items);
      const center = this.center();

      const sub = document.getElementById('radarSub');
      if (sub) {
        sub.textContent = '以 ' + (center.label || '当前位置') + ' 为中心 · 当前筛选 ' +
          items.length + ' 家';
      }

      const rings = document.getElementById('radarRings');
      if (rings) {
        const counts = metrics.counts;
        rings.innerHTML = [
          [metrics.step, counts[0]],
          [metrics.step * 2, counts[1]],
          [metrics.step * 3, counts[2]]
        ].map(([meters, count]) =>
          '<span class="radar-ring-chip"><b>' + kmLabel(meters) + '</b> 内 ' + count + ' 家</span>'
        ).join('');
      }

      const legend = document.getElementById('radarLegend');
      if (!legend) return;
      const counts = {};
      items.forEach((item) => {
        const key = item.cuisine || '其他';
        counts[key] = (counts[key] || 0) + 1;
      });
      const entries = Object.keys(counts)
        .sort((a, b) => counts[b] - counts[a])
        .slice(0, 5);
      legend.innerHTML = entries.map((name) =>
        '<span class="radar-legend-item"><i style="background:' + colorOf(name) + '"></i>' +
        util.escapeHtml(name) + ' ' + counts[name] + '</span>'
      ).join('') + (items.length ? '' : '<span class="radar-legend-empty">暂无点位</span>');
    },

    pointAt(deg, radius) {
      const rad = deg * Math.PI / 180;
      return {
        x: CX + Math.sin(rad) * radius,
        y: CY - Math.cos(rad) * radius
      };
    },

    layout(items, outer) {
      const placed = [];
      return items.map((item) => {
        const distance = this.distanceOf(item);
        const baseRadius = clamp((distance / outer) * R, 14, R - 12);
        let angle = this.bearingOf(item);
        let point = this.pointAt(angle, baseRadius);

        // 同一栋楼/同一条街的店会重叠：按固定步长旋转，找一个不撞点的方位
        for (let attempt = 0; attempt < 12; attempt++) {
          const hit = placed.some((other) =>
            Math.hypot(other.x - point.x, other.y - point.y) < 18);
          if (!hit) break;
          angle = (angle + 5) % 360;
          point = this.pointAt(angle, baseRadius);
        }

        placed.push(point);
        return { item: item, x: point.x, y: point.y, distance: distance };
      });
    },

    renderStage(items) {
      const stage = document.getElementById('radarStage');
      if (!stage) return;
      const util = App.util;

      if (!items.length) {
        stage.innerHTML =
          '<svg class="radar-svg" viewBox="0 0 340 340" role="group" aria-label="美食雷达，当前筛选下没有门店">' +
          this.backgroundSvg(1000) +
          '<text x="170" y="172" text-anchor="middle" font-size="11.5" fill="#B4A79E">当前筛选下没有店</text>' +
          '</svg>';
        return;
      }

      const metrics = this.metrics(items);
      const layout = this.layout(items, metrics.outer);
      const selected = layout.find((entry) => entry.item.id === this.selectedId);

      let svg = '<svg class="radar-svg" viewBox="0 0 340 340" role="group" aria-label="美食雷达，共 ' +
        items.length + ' 家店，可点选圆点查看">';
      svg += this.backgroundSvg(metrics.step, metrics.outer);

      // 远点先画、近点后画，避免近店被远店盖住
      layout.slice().sort((a, b) => b.distance - a.distance).forEach((entry) => {
        const item = entry.item;
        const color = colorOf(item.cuisine);
        const rating = item.rating || 4.2;
        const radius = clamp(5.4 + (rating - 4.2) * 2.2, 5.4, 8.4);
        const on = item.id === this.selectedId;
        const picked = item.id === this.pickedId;

        svg += '<g class="radar-blip' + (on ? ' is-selected' : '') + (picked ? ' is-picked' : '') +
          '" data-radar-id="' + util.escapeHtml(item.id) + '" tabindex="0" role="button" aria-label="' +
          util.escapeHtml(item.name) + '，' +
          this.directionLabel(this.bearingOf(item)) + ' ' + this.formatDistance(entry.distance) +
          (item.rating ? '，评分 ' + item.rating.toFixed(1) : '') + '">';

        if (picked) {
          svg += '<circle class="radar-ping" cx="' + entry.x.toFixed(1) + '" cy="' + entry.y.toFixed(1) +
            '" r="' + (radius + 3) + '" fill="none" stroke="' + color + '" stroke-width="1.8"/>';
        }
        svg += '<circle cx="' + entry.x.toFixed(1) + '" cy="' + entry.y.toFixed(1) +
          '" r="' + (radius + 3.4).toFixed(1) + '" fill="#FFFFFF" opacity="0.94"/>';
        svg += '<circle cx="' + entry.x.toFixed(1) + '" cy="' + entry.y.toFixed(1) +
          '" r="' + radius.toFixed(1) + '" fill="' + color + '" stroke="#FFFFFF" stroke-width="1.4"/>';
        if (rating >= 4.6) {
          svg += '<circle cx="' + entry.x.toFixed(1) + '" cy="' + entry.y.toFixed(1) +
            '" r="1.5" fill="#FFFFFF" opacity="0.9"/>';
        }
        svg += '</g>';
      });

      if (selected) {
        const name = selected.item.name.length > 10
          ? selected.item.name.slice(0, 10) + '…'
          : selected.item.name;
        const width = clamp(name.length * 12 + 20, 60, 158);
        const x = clamp(selected.x - width / 2, 4, 340 - width - 4);
        const y = selected.y > 74 ? selected.y - 34 : selected.y + 16;
        svg += '<g class="radar-tag" aria-hidden="true">' +
          '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + width.toFixed(1) +
          '" height="22" rx="7" fill="#4A3F3A" opacity="0.92"/>' +
          '<text x="' + (x + width / 2).toFixed(1) + '" y="' + (y + 15).toFixed(1) +
          '" text-anchor="middle" font-size="10.5" fill="#FFF6EC">' +
          util.escapeHtml(name) + '</text></g>';
      }

      svg += '</svg>';
      stage.innerHTML = svg;
    },

    backgroundSvg(step, outer) {
      const radius = outer || 3000;
      let svg = '<defs>' +
        '<radialGradient id="radarSweepGrad" cx="50%" cy="50%" r="50%">' +
        '<stop offset="0%" stop-color="#FF9A56" stop-opacity="0.26"/>' +
        '<stop offset="100%" stop-color="#FF9A56" stop-opacity="0"/>' +
        '</radialGradient></defs>';

      // 扫描扇形放在最底层，圆点与环线都在它上面
      svg += '<g class="radar-sweep">' +
        '<path d="M170 170 L170 28 A142 142 0 0 1 268 98 Z" fill="url(#radarSweepGrad)"/>' +
        '<path d="M170 170 L170 28" stroke="#FFB26B" stroke-width="1.2" opacity="0.55"/>' +
        '</g>';

      svg += '<circle cx="170" cy="170" r="142" fill="none" stroke="#EADCCB" stroke-width="1"/>' +
        '<circle cx="170" cy="170" r="94.7" fill="none" stroke="#EADCCB" stroke-width="1" stroke-dasharray="3 4"/>' +
        '<circle cx="170" cy="170" r="47.3" fill="none" stroke="#EADCCB" stroke-width="1" stroke-dasharray="3 4"/>';
      svg += '<path d="M28 170h284M170 28v284" stroke="#F0E4D6" stroke-width="1" stroke-dasharray="2 5"/>';

      svg += '<text x="170" y="15" text-anchor="middle" font-size="9.5" fill="#B4A79E">北</text>' +
        '<text x="331" y="174" text-anchor="middle" font-size="9.5" fill="#B4A79E">东</text>' +
        '<text x="170" y="333" text-anchor="middle" font-size="9.5" fill="#B4A79E">南</text>' +
        '<text x="9" y="174" text-anchor="middle" font-size="9.5" fill="#B4A79E">西</text>';

      const labels = [
        [R / 3, step],
        [R * 2 / 3, step * 2],
        [R - 6, radius]
      ];
      labels.forEach(([r, meters]) => {
        const x = 170 + r * 0.707 + 3;
        const y = 170 - r * 0.707 + 3;
        svg += '<text class="radar-ring-label" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
          '" font-size="9" fill="#C9B6A4">' + kmLabel(meters) + '</text>';
      });

      svg += '<circle class="radar-me-ring" cx="170" cy="170" r="13" fill="none" stroke="#4E9C7E" stroke-width="1.8" opacity="0.5"/>' +
        '<circle cx="170" cy="170" r="9" fill="#FFFFFF"/>' +
        '<circle cx="170" cy="170" r="5" fill="#4E9C7E"/>' +
        '<text x="170" y="196" text-anchor="middle" font-size="9" fill="#4E9C7E">我</text>';

      return svg;
    },

    renderCard() {
      const util = App.util;
      const card = document.getElementById('radarCard');
      const empty = document.getElementById('radarEmpty');
      const item = this.current();

      if (!item) {
        if (card) card.hidden = true;
        if (empty) {
          empty.hidden = false;
          empty.textContent = this.itemsSorted.length
            ? '点一下圆点看店，或让雷达帮你扫一家'
            : '当前筛选下没有店，放宽距离或人均再试试';
        }
        return;
      }

      if (empty) empty.hidden = true;
      if (!card) return;
      card.hidden = false;

      const status = util.openState(item);
      const picked = item.id === this.pickedId;
      const distance = this.distanceOf(item);
      const direction = this.directionLabel(this.bearingOf(item));

      card.innerHTML =
        '<div class="radar-card-top">' +
        '<span class="radar-kicker" id="radarKicker">' + (picked ? '雷达推荐' : '已选中') + '</span>' +
        (status.known
          ? '<span class="radar-state' + (status.open ? '' : ' is-closed') + '">' + status.label + '</span>'
          : '') +
        '</div>' +
        '<h3 class="radar-card-name" id="radarCardName">' + util.escapeHtml(item.name) + '</h3>' +
        '<p class="radar-meta" id="radarMeta">' +
        (item.rating ? '★ ' + item.rating.toFixed(1) : '暂无评分') +
        ' · ' + util.escapeHtml(item.cuisine || '美食') +
        ' · ' + (item.avgPrice ? '人均 ¥' + item.avgPrice : '人均待补充') +
        ' · ' + direction + ' ' + this.formatDistance(distance) +
        '</p>' +
        '<p class="radar-address">' + util.escapeHtml(item.address || '地址待补充') + '</p>' +
        '<button class="btn-mint radar-detail" id="radarDetailBtn" type="button">看看这家</button>';
    },

    current() {
      if (!this.selectedId) return null;
      return this.itemsSorted.find((item) => item.id === this.selectedId) || null;
    },

    /* ---------------- 交互 ---------------- */

    open() {
      if (!this.layer) return;
      this.selectedId = null;
      this.pickedId = null;
      this.render();
      this.layer.classList.add('is-open');
      this.layer.setAttribute('aria-hidden', 'false');
      App.state.radarOpen = true;
      document.body.classList.add('is-checkin');
      App.updateChrome();
    },

    close() {
      if (!this.layer) return;
      if (this.scanTimer) {
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
      }
      this.scanning = false;
      this.layer.classList.remove('is-open', 'is-scanning');
      this.layer.setAttribute('aria-hidden', 'true');
      App.state.radarOpen = false;
      document.body.classList.remove('is-checkin');
      App.updateChrome();
    },

    select(id) {
      if (!id) return;
      this.selectedId = String(id);
      this.renderStage(this.items());
      this.renderCard();
    },

    scan() {
      if (this.scanning) return;
      const items = this.items();
      if (!items.length) {
        App.util.toast('当前筛选下没有可扫的店，放宽条件试试');
        return;
      }

      this.scanning = true;
      this.pickedId = null;
      this.layer.classList.add('is-scanning');
      App.util.haptic([12, 20, 12]);

      this.scanTimer = setTimeout(() => {
        const item = Draw.weightedPick(items);
        this.scanning = false;
        this.scanTimer = null;
        this.layer.classList.remove('is-scanning');
        if (!item) return;
        this.pickedId = item.id;
        this.selectedId = item.id;
        this.renderStage(this.items());
        this.renderCard();
        App.util.haptic(18);
      }, 760);
    },

    goDetail() {
      const item = this.current();
      if (!item) return;
      this.close();
      Detail.open(item);
    }
  };

  window.Radar = Radar;
})();
