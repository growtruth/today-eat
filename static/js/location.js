/* 定位：权限请求、GPS 定位、坐标转换、逆地理编码、IP 兜底、任意位置搜索 */
(function () {
  'use strict';

  const App = window.App;
  const util = App.util;

  function updateLabel() {
    const label = document.getElementById('locLabel');
    if (label) label.textContent = (App.state.location && App.state.location.label) || '选择位置';
  }

  /* 统一写入定位结果：更新状态、持久化、刷新标签 */
  function applyLocation(lat, lng, label, manual, extra) {
    const meta = extra || {};
    App.state.location = {
      lat: lat,
      lng: lng,
      label: label,
      city: meta.city || '',
      manual: !!manual,
      accuracy: meta.accuracy == null ? null : Math.round(meta.accuracy),
      source: meta.source || 'gps',
      rawLat: meta.rawLat == null ? null : Number(Number(meta.rawLat).toFixed(6)),
      rawLng: meta.rawLng == null ? null : Number(Number(meta.rawLng).toFixed(6))
    };
    Store.setLocation(App.state.location);
    updateLabel();
  }

  /* WGS-84 → GCJ-02：浏览器 GPS 返回 WGS-84，高德接口用 GCJ-02，不转会有约 500m 偏移 */
  function wgs84ToGcj02(lat, lng) {
    const A = 6378245.0;
    const EE = 0.00669342162296594323;
    function outOfChina(la, lo) {
      return !(72.004 <= lo && lo <= 137.8347 && 0.8293 <= la && la <= 55.8271);
    }
    function transformLat(x, y) {
      let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
      ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
      ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
      return ret;
    }
    function transformLng(x, y) {
      let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
      ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
      ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
      return ret;
    }
    if (outOfChina(lat, lng)) return [lat, lng];
    let dlat = transformLat(lng - 105.0, lat - 35.0);
    let dlng = transformLng(lng - 105.0, lat - 35.0);
    const radlat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radlat);
    magic = 1 - EE * magic * magic;
    const sqrtmagic = Math.sqrt(magic);
    dlat = (dlat * 180.0) / ((A * (1 - EE)) / (magic * sqrtmagic) * Math.PI);
    dlng = (dlng * 180.0) / (A / sqrtmagic * Math.cos(radlat) * Math.PI);
    return [Number((lat + dlat).toFixed(6)), Number((lng + dlng).toFixed(6))];
  }

  /* GPS 定位：直接调用 getCurrentPosition，由浏览器/微信弹出授权；失败按错误码归类 */
  function locate(onResult) {
    if (!navigator.geolocation) {
      onResult({ ok: false, reason: 'unsupported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (position) {
        onResult({
          ok: true,
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
          accuracy: Math.round(position.coords.accuracy || 0)
        });
      },
      function (error) {
        const map = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };
        onResult({ ok: false, reason: map[error.code] || 'unavailable' });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /* GPS 定位成功：转坐标 → 存位置 → 刷新周边 → 逆地理编码出具体地名 */
  function onGeoSuccess(lat, lng, opts) {
    const gcj = wgs84ToGcj02(lat, lng);
    const gLat = gcj[0];
    const gLng = gcj[1];
    const meta = { accuracy: opts && opts.accuracy, source: 'gps', rawLat: lat, rawLng: lng };
    applyLocation(gLat, gLng, '当前位置', false, meta);
    if (opts && opts.closeSheet) util.closeSheet();
    util.toast('已定位到当前位置，正在刷新周边…');
    App.reloadData();
    // 异步把「当前位置」替换成具体地名（如「北京市朝阳区」），失败则保持原样
    API.regeo(gLat, gLng).then(function (data) {
      const place = data.place;
      if (place && place.label) {
        // 保留 city：饭搭子把「商圈」换算成坐标时用它限定城市，避免搜到外地的同名地点
        applyLocation(gLat, gLng, place.label, false,
          Object.assign({}, meta, { city: place.city || '' }));
      }
    }).catch(function () {});
  }

  /* GPS 失败：尝试 IP 定位兜底（城市级），失败再降级手动选位置 */
  function onGeoFail(opts) {
    util.loading(true, '正在网络定位…');
    API.ipLocate().then(function (data) {
      util.loading(false);
      const place = data.place;
      if (place && place.lat && place.lng) {
        const label = place.label || '当前位置';
        applyLocation(place.lat, place.lng, label, false, { source: 'ip', city: place.city || '' });
        util.toast('已按网络定位到 ' + label + '，可能不太精确', 2600);
        App.reloadData();
      } else if (!(opts && opts.silent)) {
        promptManual();
      }
    }).catch(function () {
      util.loading(false);
      if (!(opts && opts.silent)) promptManual();
    });
  }

  /* 在定位弹层内展示权限未开启的提示（若弹层已关则退回 toast） */
  function showPermissionHint() {
    const hint = document.getElementById('geoPermissionHint');
    if (hint) {
      hint.hidden = false;
      return;
    }
    util.toast('定位权限未开启，请允许浏览器定位，或直接搜索位置', 3200);
  }

  function handleLocateError(reason) {
    if (reason === 'denied') showPermissionHint();
    else if (reason === 'unsupported') util.toast('当前浏览器不支持定位，请直接搜索位置', 3000);
    else onGeoFail();
  }

  /* 一键定位：直接请求 GPS → 自动刷新周边店铺 */
  function locateOnce() {
    util.loading(true, '正在请求定位权限…');
    locate(function (result) {
      util.loading(false);
      if (result.ok) {
        onGeoSuccess(result.lat, result.lng, { accuracy: result.accuracy, closeSheet: true });
      } else {
        handleLocateError(result.reason);
      }
    });
  }

  /* 进入时定位：firstLoad=首次（定位失败要引导手动选），silent=静默刷新（失败不打扰） */
  function start(options) {
    const opts = options || {};
    locate(function (result) {
      if (result.ok) {
        onGeoSuccess(result.lat, result.lng, { accuracy: result.accuracy });
      } else if (opts.silent) {
        onGeoFail({ silent: true });
      } else {
        onGeoFail();
      }
    });
  }

  function promptManual() {
    if (sessionStorage.getItem('loc_prompted') === '1') {
      util.toast('定位没开，点左上角可手动选位置', 2600);
      return;
    }
    sessionStorage.setItem('loc_prompted', '1');
    util.toast('定位没开，先手动选个位置');
    setTimeout(openSheet, 500);
  }

  function openSheet() {
    const body = document.createElement('div');

    // 一键定位按钮
    const geoBtn = document.createElement('button');
    geoBtn.type = 'button';
    geoBtn.className = 'loc-geo-btn';
    geoBtn.innerHTML =
      '<span class="loc-geo-ico"><svg class="ico"><use href="#i-locate"></use></svg></span>' +
      '<span class="loc-geo-text"><b>使用我的当前位置</b><i>允许浏览器定位，自动刷新周边店铺</i></span>' +
      '<svg class="ico loc-geo-chev"><use href="#i-chev"></use></svg>';
    geoBtn.addEventListener('click', locateOnce);
    body.appendChild(geoBtn);

    // 已定位时提供「查看定位详情」入口（坐标/地址/地图/地标/推荐依据）
    if (App.state.location) {
      const detailBtn = document.createElement('button');
      detailBtn.type = 'button';
      detailBtn.className = 'loc-detail-link';
      detailBtn.innerHTML =
        '<span>查看定位详情</span>' +
        '<span class="loc-detail-cur">' + util.escapeHtml(App.state.location.label || '当前位置') + '</span>' +
        '<svg class="ico"><use href="#i-chev"></use></svg>';
      detailBtn.addEventListener('click', function () {
        util.closeSheet();
        LocDetail.open();
      });
      body.appendChild(detailBtn);
    }

    // 权限未开启提示（默认隐藏，被拒后显示）
    const hint = document.createElement('div');
    hint.id = 'geoPermissionHint';
    hint.className = 'loc-perm-hint';
    hint.hidden = true;
    hint.innerHTML =
      '<svg class="ico"><use href="#i-locate"></use></svg>' +
      '<span>定位权限未开启：请在浏览器地址栏的权限设置中允许「位置信息」，或直接在下方搜索位置。</span>';
    body.appendChild(hint);

    // 分隔
    const divider = document.createElement('div');
    divider.className = 'loc-divider';
    divider.innerHTML = '<span>或搜索任意位置</span>';
    body.appendChild(divider);

    // 城市
    const cityLabel = document.createElement('div');
    cityLabel.className = 'field-label';
    cityLabel.innerHTML = '<span>城市</span>';
    body.appendChild(cityLabel);

    const cityInput = document.createElement('input');
    cityInput.id = 'cityInput';
    cityInput.className = 'text-input';
    cityInput.value = (App.boot.defaults && App.boot.defaults.city) || '北京';
    cityInput.maxLength = 10;
    cityInput.placeholder = '如：北京、上海、深圳';
    body.appendChild(cityInput);

    // 位置（商圈 / 地标 / 地址）
    const areaLabel = document.createElement('div');
    areaLabel.className = 'field-label';
    areaLabel.style.marginTop = '14px';
    areaLabel.innerHTML = '<span>商圈 / 地标 / 地址</span>';
    body.appendChild(areaLabel);

    const areaInput = document.createElement('input');
    areaInput.id = 'areaInput';
    areaInput.className = 'text-input';
    areaInput.value = '';
    areaInput.maxLength = 30;
    areaInput.placeholder = '如：望京、国贸、三里屯，或任意详细地址';
    body.appendChild(areaInput);

    const chips = document.createElement('div');
    chips.className = 'area-chips';
    chips.id = 'areaChips';
    body.appendChild(chips);

    const note = document.createElement('p');
    note.className = 'loc-note';
    note.textContent = '支持任意商圈、地标或详细地址，会通过地理编码换算成坐标。';
    body.appendChild(note);

    util.openSheet({
      title: '你在哪儿附近？',
      subtitle: '允许定位可自动刷新周边店铺，也可以直接搜索位置',
      body: body,
      actions: [
        { label: '取消', variant: 'ghost' },
        {
          label: '用这个位置',
          onClick: () => {
            const city = cityInput.value.trim() || '北京';
            const area = areaInput.value.trim();
            if (!area) {
              util.toast('先填一个商圈、地标或地址');
              return false;
            }
            apply(city, area);
          }
        }
      ]
    });

    // 热门商圈快捷选择（按当前城市拉取）
    const city = cityInput.value.trim() || '北京';
    loadAreaChips(city);
    cityInput.addEventListener('change', function () {
      const next = cityInput.value.trim() || '北京';
      const box = document.getElementById('areaChips');
      if (box) box.innerHTML = '';
      loadAreaChips(next);
    });
  }

  function loadAreaChips(city) {
    API.areas(city).then(function (data) {
      const box = document.getElementById('areaChips');
      if (!box) return;
      (data.items || []).slice(0, 12).forEach(function (item) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = item.name;
        chip.addEventListener('click', function () {
          const input = document.getElementById('areaInput');
          if (input) input.value = item.name;
        });
        box.appendChild(chip);
      });
    }).catch(function () {});
  }

  async function apply(city, area) {
    util.loading(true, '正在定位这个位置…');
    try {
      const data = await API.geocode(area, city);
      const place = data.place;
      applyLocation(place.lat, place.lng, place.name || (city + ' · ' + area), true,
        { source: 'search', city: place.city || city || '' });
      util.closeSheet();
      util.toast('已切换到 ' + (place.name || area));
      App.reloadData();
    } catch (error) {
      util.toast(error.message || '这个位置没找到');
    } finally {
      util.loading(false);
    }
  }

  window.LocationPicker = {
    start: start,
    prompt: promptManual,
    openSheet: openSheet,
    apply: apply,
    locateOnce: locateOnce,
    updateLabel: updateLabel
  };
})();
