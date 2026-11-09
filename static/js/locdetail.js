/* 定位详情：经纬度、街道/POI 级地址、地图（我的位置 + 周边地标）、位置感知推荐 */
(function () {
  'use strict';

  const App = window.App;
  const util = App.util;

  const SOURCE_LABEL = {
    gps: '浏览器 GPS',
    ip: '网络 IP 定位',
    search: '手动搜索'
  };

  const LocDetail = {
    layer: null,
    mapHandle: null,
    data: null,
    busy: false,

    init() {
      this.layer = document.getElementById('locLayer');
      const close = document.getElementById('locClose');
      if (close) close.addEventListener('click', () => this.close());
      const zin = document.getElementById('locZoomIn');
      const zout = document.getElementById('locZoomOut');
      if (zin) zin.addEventListener('click', () => this.zoom(1));
      if (zout) zout.addEventListener('click', () => this.zoom(-1));
    },

    isOpen() {
      return !!(this.layer && this.layer.classList.contains('is-open'));
    },

    open() {
      if (!this.layer) return;
      const loc = App.state.location;
      if (!loc) {
        util.toast('还没定位，先允许定位或手动选个位置');
        App.openLocationSheet();
        return;
      }
      this.layer.classList.add('is-open');
      this.layer.setAttribute('aria-hidden', 'false');
      App.state.locOpen = true;
      document.body.classList.add('is-checkin');
      App.updateChrome();
      this.load();
    },

    close() {
      if (!this.layer) return;
      this.layer.classList.remove('is-open');
      this.layer.setAttribute('aria-hidden', 'true');
      App.state.locOpen = false;
      document.body.classList.remove('is-checkin');
      App.updateChrome();
      this.destroyMap();
    },

    destroyMap() {
      if (this.mapHandle && this.mapHandle.destroy) this.mapHandle.destroy();
      this.mapHandle = null;
    },

    zoom(delta) {
      if (this.mapHandle && this.mapHandle.zoom) this.mapHandle.zoom(delta);
    },

    async load() {
      const loc = App.state.location;
      if (!loc) return;
      this.renderCoord(loc);
      this.setBusy(true);
      try {
        const data = await API.locateContext(loc.lat, loc.lng, 3000);
        this.data = data;
        this.renderAddress(data.address);
        const landmarks = data.landmarks || [];
        this.renderLandmarks(landmarks);
        this.renderInsight(data.insight, data.picks || []);
        this.renderMap(loc, landmarks);
      } catch (error) {
        util.toast(error.message || '定位详情没拉到');
      } finally {
        this.setBusy(false);
      }
    },

    setBusy(show) {
      this.busy = show;
      const hint = document.getElementById('locMapHint');
      if (hint) hint.textContent = show ? '正在读取周边地标与推荐…' : '拖动/缩放看周边 · 点标记看详情';
    },

    renderCoord(loc) {
      const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
      setText('locLng', Number(loc.lng).toFixed(6));
      setText('locLat', Number(loc.lat).toFixed(6));
      setText('locAccuracy', loc.accuracy ? '精度约 ' + loc.accuracy + ' 米' : '精度未知');
      setText('locSource', '来源：' + (SOURCE_LABEL[loc.source] || '浏览器 GPS'));
      const raw = (loc.rawLat != null && loc.rawLng != null)
        ? '原始 WGS-84：' + Number(loc.rawLat).toFixed(6) + ', ' + Number(loc.rawLng).toFixed(6)
        : '';
      setText('locRaw', raw);
    },

    renderAddress(addr) {
      const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
      if (!addr) {
        setText('locAddrPrecise', '地址解析暂不可用');
        setText('locAddrFull', '');
        return;
      }
      setText('locAddrPrecise', addr.precise || addr.label || addr.name || '当前位置');
      setText('locAddrFull', addr.name || '');

      const box = document.getElementById('locAddrTags');
      if (!box) return;
      const tags = [];
      if (addr.level === 'poi') tags.push({ text: 'POI 级', on: true });
      if (addr.poiType) tags.push({ text: '类型 ' + addr.poiType, on: false });
      if (addr.township) tags.push({ text: addr.township, on: false });
      box.innerHTML = tags.map((tag) =>
        '<span class="loc-tag' + (tag.on ? ' is-on' : '') + '">' + util.escapeHtml(tag.text) + '</span>'
      ).join('');
    },

    renderLandmarks(landmarks) {
      const box = document.getElementById('locLandmarks');
      const count = document.getElementById('locLandmarkCount');
      if (count) count.textContent = landmarks.length + ' 个';
      if (!box) return;
      if (!landmarks.length) {
        box.innerHTML = '<p class="loc-empty">周边暂时没有可展示的地标</p>';
        return;
      }
      box.innerHTML = landmarks.map((lm, index) =>
        '<button class="loc-lm" type="button" data-index="' + index + '">' +
        '<span class="loc-lm-kind" data-kind="' + util.escapeHtml(lm.kind || '地标') + '">' +
        util.escapeHtml(lm.kind || '地标') + '</span>' +
        '<span class="loc-lm-main"><b>' + util.escapeHtml(lm.name) + '</b>' +
        '<i>' + util.escapeHtml(lm.address || lm.type || '') + '</i></span>' +
        '<span class="loc-lm-dist">' +
        (lm.distance >= 1000 ? (lm.distance / 1000).toFixed(1) + 'km' : lm.distance + 'm') +
        '</span></button>'
      ).join('');
      box.querySelectorAll('.loc-lm').forEach((node) => {
        node.addEventListener('click', () => {
          const lm = landmarks[Number(node.getAttribute('data-index'))];
          if (lm) this.showLandmark(lm);
        });
      });
    },

    showLandmark(lm) {
      const body = document.createElement('div');
      body.innerHTML =
        '<div class="loc-lm-detail">' +
        '<div class="loc-lm-detail-head">' +
        '<span class="loc-lm-kind" data-kind="' + util.escapeHtml(lm.kind || '地标') + '">' +
        util.escapeHtml(lm.kind || '地标') + '</span>' +
        '<b>' + util.escapeHtml(lm.name) + '</b></div>' +
        '<p class="loc-lm-detail-row"><span>距离</span><b>' +
        (lm.distance >= 1000 ? (lm.distance / 1000).toFixed(1) + ' km' : lm.distance + ' 米') +
        '</b></p>' +
        (lm.address ? '<p class="loc-lm-detail-row"><span>地址</span><b>' + util.escapeHtml(lm.address) + '</b></p>' : '') +
        (lm.type ? '<p class="loc-lm-detail-row"><span>类型</span><b>' + util.escapeHtml(lm.type) + '</b></p>' : '') +
        '<p class="loc-lm-detail-row"><span>坐标</span><b>' +
        Number(lm.lat).toFixed(6) + ', ' + Number(lm.lng).toFixed(6) + '</b></p>' +
        '</div>';
      util.openSheet({
        title: '地标详情',
        subtitle: '来自地图公开 POI 数据',
        body: body,
        actions: [{ label: '知道了', variant: 'ghost' }]
      });
    },

    renderInsight(insight, picks) {
      const ins = insight || {};
      const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
      setText('locAreaType', ins.areaType || '--');
      setText('locInsight', ins.tip || '');
      setText('locRule', ins.rule ? '权重：' + ins.rule : '');

      const box = document.getElementById('locPicks');
      if (!box) return;
      if (!picks.length) {
        box.innerHTML = '<p class="loc-empty">附近暂时没有可推荐的店</p>';
        return;
      }
      box.innerHTML = picks.map((p, index) => {
        const nearest = p.nearestLandmark;
        return '<button class="loc-pick" type="button" data-index="' + index + '">' +
          '<span class="loc-pick-rank">' + (index + 1) + '</span>' +
          '<span class="loc-pick-main"><b>' + util.escapeHtml(p.name) + '</b>' +
          '<i>' + util.escapeHtml(p.cuisine || '') + ' · 步行 ' + (p.walkMinutes || 0) + ' 分钟' +
          (nearest ? ' · 近' + util.escapeHtml(nearest.name) : '') + '</i></span>' +
          '<span class="loc-pick-score">' + (p.contextScore || 0) + '<i>分</i></span>' +
          '</button>';
      }).join('');
      box.querySelectorAll('.loc-pick').forEach((node) => {
        node.addEventListener('click', () => {
          const pick = picks[Number(node.getAttribute('data-index'))];
          if (!pick) return;
          this.close();
          Detail.open(pick);
        });
      });
    },

    renderMap(loc, landmarks) {
      const el = document.getElementById('locMap');
      if (!el) return;
      this.destroyMap();
      this.mapHandle = MapView.renderLocate(el, {
        me: { lat: loc.lat, lng: loc.lng },
        landmarks: landmarks,
        onPick: (lm) => this.showLandmark(lm)
      });
    }
  };

  window.LocDetail = LocDetail;
})();
