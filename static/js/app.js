/* 应用编排：初始化、数据加载、周末模式、事件绑定、分享直达 */
(function () {
  'use strict';

  const App = window.App;
  const util = App.util;

  // 页面栈、定位、采集说明已拆到独立模块，这里只保留对外别名，调用方无需改
  App.navigateTo = Router.navigateTo;
  App.goHome = Router.goHome;
  App.onPageChange = Router.onPageChange;
  App.updateChrome = Router.updateChrome;
  App.openLocationSheet = LocationPicker.openSheet;
  App.openLocDetail = function () { LocDetail.open(); };
  App.openSourceSheet = SourceSheet.open;

  // 请求串行化：新请求发起时取消旧请求，避免慢响应覆盖新结果
  let activeSearch = null;
  let searchSeq = 0;

  // 半径阶梯：只作为「同一半径翻到底」之后的兜底升档
  const RADIUS_STEPS = [3000, 5000, 8000];
  // 每次触底取多少条：25 一页对齐高德，50 = 2 页
  const PAGE_LIMIT = 50;

  function radiusFor(distance) {
    if (distance === 0) return 8000;
    if (distance >= 5000) return 5000;
    return 3000;
  }

  /** 分页上限：用户选了距离档位就不能越过它，否则会把筛选外的店也拉回来 */
  function distanceCeiling() {
    const distance = Number(Filters.state.distance) || 0;
    return distance > 0 ? Math.max(1000, Math.min(8000, distance)) : RADIUS_STEPS[RADIUS_STEPS.length - 1];
  }

  App.init = function () {
    Store.load();
    Cloud.init();

    const saved = Store.getLocation();
    const hasSaved = !!saved;
    // 无保存位置时不预设地址，等待真实定位（成功后再加载周边店铺）
    App.state.location = saved || null;
    LocationPicker.updateLabel();

    const weekend = Store.resolveWeekend(App.boot.weekend && App.boot.weekend.autoWeekendMode);
    App.state.weekend = weekend.value;
    App.state.weekendManual = weekend.manual;
    App.state.weekendSubmode = Store.resolveWeekendSubmode();

    Pager.init();
    Filters.init();
    Feed.init();
    Detail.init();
    Nav.init();
    Checkin.init();
    Buddy.init();
    Play.init();
    Draw.init();
    Radar.init();
    LocDetail.init();

    bindEvents();
    Router.init();
    syncWeekendUI();
    Router.updateChrome();
    if (hasSaved) {
      loadData(); // 已有位置才加载
    } else {
      Feed.setItems([]); // 未定位：渲染"正在获取位置"占位，等真实定位后再加载
    }

    // 本机匿名身份：搭子/邀请/骰子需要会话，失败不影响选店主链路
    Buddy.ensureSession().then((ok) => {
      if (!ok) Buddy.renderProfile();
    });

    // 云服务会话：登录态决定打卡是否上云，失败静默降级为本机存储
    Cloud.restore().then(async (result) => {
      Checkin.refreshCloudState();
      // 有云会话就换成本站会话：服务端会再向云端核验一次 token
      if (result && result.user) await linkCloudAccount();
    });

    const sharedStore = new URLSearchParams(location.search).get('store');
    if (sharedStore) openSharedStore(sharedStore);

    // 微信授权回跳：把结果反馈给用户
    handleWechatResult(new URLSearchParams(location.search));

    // 真实定位：首次进入必须先定位（成功才加载）；GPS 定位过的静默刷新；手动选过的尊重不覆盖
    const noGeo = location.search.indexOf('nogeo=1') >= 0;
    if (noGeo) {
      // 测试/降级：跳过定位，用默认位置兜底（仅此场景才用预设地址）
      if (!hasSaved) {
        App.state.location = {
          lat: App.boot.defaults.lat,
          lng: App.boot.defaults.lng,
          label: App.boot.defaults.city + ' · ' + App.boot.defaults.area,
          manual: false
        };
        LocationPicker.updateLabel();
        loadData();
      }
    } else if (!hasSaved) {
      LocationPicker.start({ firstLoad: true });
    } else if (saved.manual !== true) {
      LocationPicker.start({ silent: true });
    }
    guardUnload();
  };

  function bindEvents() {
    const toggle = document.getElementById('weekendSwitch');
    if (toggle) {
      toggle.checked = App.state.weekend;
      toggle.addEventListener('change', function () {
        App.setWeekend(this.checked, true);
      });
    }

    const weekendModes = document.getElementById('weekendModes');
    if (weekendModes) {
      weekendModes.addEventListener('click', function (event) {
        const btn = event.target.closest('[data-submode]');
        if (!btn) return;
        App.setWeekendSubmode(btn.dataset.submode, true);
      });
    }

    const search = document.getElementById('searchInput');
    if (search) {
      const run = util.debounce(function () {
        App.state.keyword = search.value.trim();
        App.applyFilters();
        if (App.state.page !== 0) App.goHome(false);
      }, 220);
      search.addEventListener('input', run);
      search.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          search.blur();
          App.state.keyword = search.value.trim();
          App.applyFilters();
        }
      });
    }

    const searchBtn = document.getElementById('searchBtn');
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        const input = document.getElementById('searchInput');
        App.state.keyword = input.value.trim();
        App.applyFilters();
      });
    }

    const playDraw = document.getElementById('playDraw');
    if (playDraw) playDraw.addEventListener('click', () => Draw.trigger());

    const locBtn = document.getElementById('locBtn');
    if (locBtn) locBtn.addEventListener('click', () => LocationPicker.openSheet());

    const refresh = document.getElementById('refreshBtn');
    if (refresh) refresh.addEventListener('click', () => App.goHome(true));

    const sourceBtn = document.getElementById('sourceBtn');
    if (sourceBtn) sourceBtn.addEventListener('click', () => SourceSheet.open());

    const hintClose = document.getElementById('gestureHintClose');
    if (hintClose) hintClose.addEventListener('click', () => Router.hideHint());

    document.querySelectorAll('[data-home]').forEach((btn) => {
      btn.addEventListener('click', () => App.goHome(false));
    });

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', function () {
        const target = tab.dataset.tab;
        if (target === 'home') {
          Checkin.close();
          Buddy.close();
          App.goHome(false);
        } else if (target === 'draw') {
          Checkin.close();
          Buddy.close();
          Draw.trigger();
        } else if (target === 'buddies') {
          Checkin.close();
          Buddy.open();
        } else if (target === 'checkin') {
          Buddy.close();
          Checkin.open();
        }
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) Bubbles.pause();
      else if (App.state.page === 1 && !App.state.checkinOpen) Bubbles.start();
    });
  }

  App.setWeekend = function (value, fromUser) {
    App.state.weekend = !!value;
    if (fromUser) {
      Store.setWeekend(App.state.weekend);
      App.state.weekendManual = true;
      const solo = App.state.weekendSubmode !== 'group';
      util.toast(App.state.weekend
        ? (solo ? '已开启周末模式 · 一个人吃' : '已开启周末模式 · 一起聚餐')
        : '已切回日常推荐');
    }
    syncWeekendUI();
    App.applyFilters();
  };

  App.setWeekendSubmode = function (mode, fromUser) {
    App.state.weekendSubmode = mode === 'group' ? 'group' : 'solo';
    if (fromUser) {
      Store.setWeekendSubmode(App.state.weekendSubmode);
      util.toast(App.state.weekendSubmode === 'solo'
        ? '周末 solo · 只推适合一个人的店'
        : '周末聚餐 · 只推适合多人的店');
    }
    syncWeekendUI();
    App.applyFilters();
  };

  function syncWeekendUI() {
    const toggle = document.getElementById('weekendSwitch');
    if (toggle) toggle.checked = App.state.weekend;
    const wrap = document.querySelector('.weekend-switch');
    if (wrap) wrap.classList.toggle('is-on', App.state.weekend);

    const panel = document.getElementById('weekendPanel');
    if (panel) panel.hidden = !App.state.weekend;

    const solo = App.state.weekendSubmode !== 'group';
    const bannerText = document.getElementById('weekendBannerText');
    if (bannerText) {
      bannerText.textContent = solo
        ? '周末模式 · 一个人也要好好吃饭'
        : '周末模式 · 只推适合聚餐的店';
    }

    document.querySelectorAll('#weekendModes [data-submode]').forEach((btn) => {
      const on = btn.dataset.submode === App.state.weekendSubmode;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  App.applyFilters = util.debounce(function () {
    Feed.render();
  }, 60);

  App.reloadData = function () {
    loadData();
  };

  async function loadData() {
    const location = App.state.location || {};
    const radius = radiusFor(Filters.state.distance);
    const seq = ++searchSeq;

    // 新的搜索条件 / 定位：重置游标分页
    App.state.pagination = { radius: radius, offset: 0, loading: false, noMore: false };
    Feed.clearStatus();

    if (activeSearch) activeSearch.abort();
    const controller = new AbortController();
    activeSearch = controller;

    // 首屏才用整屏遮罩；换筛选/换定位时保留当前列表，避免上下文被遮断
    const firstLoad = !Feed.items.length;
    if (firstLoad) util.loading(true, '正在找附近好吃的…');
    App.state.loading = true;

    try {
      const data = await API.restaurants({
        lat: location.lat,
        lng: location.lng,
        radius: radius,
        q: App.state.keyword,
        offset: 0,
        limit: PAGE_LIMIT
      }, { signal: controller.signal });

      if (seq !== searchSeq) return; // 旧响应，直接丢弃

      App.state.sourceInfo = data;
      App.state.fetchedRadius = data.radius || radius;
      Feed.setItems(data.items || []);
      updateSourceBadge(data);
      if (App.state.radarOpen) Radar.render();
      if (firstLoad) Router.showHint();
      if (data.expanded) {
        util.toast('3 公里内选择不多，已扩大到 ' + (data.radius / 1000) + ' 公里', 2200);
      }

      // 首屏实际半径 + 服务端游标 = 分页起点
      App.state.pagination.radius = data.radius || radius;
      App.state.pagination.offset = data.nextOffset != null
        ? data.nextOffset
        : (data.items || []).length;
      App.state.pagination.noMore = data.hasMore === false &&
        App.state.pagination.radius >= distanceCeiling();
      if (App.state.pagination.noMore) Feed.showNoMore();
    } catch (error) {
      if (error.code === 'aborted' || seq !== searchSeq) return;
      Feed.showError(error);
      const badge = document.getElementById('sourceBadge');
      if (badge) badge.textContent = '数据没拉到';
    } finally {
      if (seq === searchSeq) {
        util.loading(false);
        App.state.loading = false;
        activeSearch = null;
      }
    }
  }

  /**
   * 触底加载更远一批：
   * - 同一半径内按 offset 往后翻页（数据源按距离升序，翻到的是真正更远的店）
   * - 这一档翻到底才升半径（3→5→8km），升档后 offset 归零，靠 id 去重兜住重叠
   * - loading 锁防重复触发；距离筛选是硬上限，不越过用户选的档位
   */
  App.loadMoreByRadius = async function () {
    const p = App.state.pagination;
    if (!p || p.loading || p.noMore) return false;

    const seq = searchSeq;
    const ceiling = distanceCeiling();
    // 用户把距离档位调小后，已加载半径要跟着收回来，否则「到底」文案会写错
    if (p.radius > ceiling) p.radius = ceiling;

    p.loading = true;
    Feed.setLoadingMore(true);

    try {
      for (let round = 0; round <= RADIUS_STEPS.length; round++) {
        const loc = App.state.location || {};
        let data = null;
        try {
          data = await API.restaurants({
            lat: loc.lat,
            lng: loc.lng,
            radius: p.radius,
            q: App.state.keyword,
            strict: 1,
            offset: p.offset,
            limit: PAGE_LIMIT
          });
        } catch (err) {
          if (seq !== searchSeq) return false;
          // 这一档确实没有更多：升一档继续，游标保留（数据源按距离升序，不必从头再翻）
          if (err.code === 'empty' || err.code === 'not_found') {
            const next = RADIUS_STEPS.find((r) => r > p.radius);
            if (next == null || next > ceiling) { p.noMore = true; break; }
            p.radius = next;
            continue;
          }
          throw err;
        }

        if (seq !== searchSeq) return false; // 期间切换了筛选/定位，丢弃结果

        p.radius = data.radius || p.radius;
        p.offset = data.nextOffset != null ? data.nextOffset : p.offset + (data.items || []).length;

        const added = Feed.appendItems(data.items || []);
        if (added > 0) {
          if (App.state.radarOpen) Radar.render();
          p.noMore = data.hasMore === false && p.radius >= ceiling;
          if (p.noMore) Feed.showNoMore();
          else Feed.clearStatus();
          return true;
        }
        // 这一页全是已加载过的店，但服务端还有下一页：继续往后翻
        if (data.hasMore) continue;

        const next = RADIUS_STEPS.find((r) => r > p.radius);
        if (next == null || next > ceiling) { p.noMore = true; break; }
        p.radius = next;
      }

      if (p.noMore) Feed.showNoMore();
      return false;
    } catch (error) {
      if (error.code !== 'aborted') util.toast(error.message || '更远的店没拉到', 2400);
      return false;
    } finally {
      if (seq === searchSeq) {
        p.loading = false;
        Feed.setLoadingMore(false);
      }
    }
  };

  /**
   * 距离档位变化：新档位在已拉取半径内时本地过滤，超出时才重新请求。
   * 避免“先渲染旧数据、再发请求”造成的闪烁与重复渲染。
   */
  App.changeDistance = function (value) {
    const distance = Number(value) || 0;
    Filters.state.distance = distance;
    Filters.renderFilterChips();
    Filters.renderCond();

    // 已加载半径：优先用分页状态（比 fetchedRadius 更准确反映当前拉到哪一档）
    const fetched = (App.state.pagination && App.state.pagination.radius) || App.state.fetchedRadius || 3000;
    const needed = distance === 0
      ? RADIUS_STEPS[RADIUS_STEPS.length - 1]
      : Math.max(1000, Math.min(RADIUS_STEPS[RADIUS_STEPS.length - 1], distance));
    if (needed > fetched) {
      App.reloadData();
    } else {
      // 收窄时把半径上限一起收回来，避免「到底」文案仍写 8km
      if (App.state.pagination) {
        App.state.pagination.radius = needed;
        App.state.pagination.noMore = false;
      }
      App.applyFilters();
    }
  };

  /* ---------------- 分享链接直达 ---------------- */
  async function openSharedStore(id) {
    util.loading(true, '正在打开分享的店…');
    try {
      const data = await API.detail(id);
      const item = data.item || {};
      item.distanceLabel = item.distanceLabel || '';
      Detail.open(item);
    } catch (error) {
      util.toast('这家店没找到，看看附近的吧');
    } finally {
      util.loading(false);
    }
  }

  /* ---------------- 微信授权回跳结果 ---------------- */
  /** 用 WorkBuddy 账号的云会话换本站会话，成功后刷新搭子身份 */
  async function linkCloudAccount() {
    const token = await Cloud.accessToken();
    if (!token) return false;
    try {
      const data = await API.authCloud(token, Store.deviceId());
      App.state.user = data.user || null;
      Buddy.ready = true;
      Buddy.error = null;
      if (App.state.buddyOpen) Buddy.refresh();
      else Buddy.renderProfile();
      return true;
    } catch (error) {
      // 云会话过期：回退本机身份，不打断选店流程
      return false;
    }
  }

  function handleWechatResult(params) {
    const code = params.get('wechat');
    if (!code) return;
    const map = {
      unconfigured: '微信登录还没配置，先用本机身份吧',
      state_invalid: '登录校验失败，请重新打开微信登录',
      state_expired: '登录链接已过期，请重新发起',
      no_code: '微信未返回授权码，请重试',
      failed: '微信登录失败，请稍后再试'
    };
    if (code === 'ok') {
      util.toast('微信登录成功', 2200);
      // 立刻换回微信身份：不清空会话状态的话，面板里会一直显示「本机身份」
      App.state.user = null;
      Buddy.ready = false;
      Buddy.pending = null;
      linkCloudAccount().finally(() => Buddy.refresh());
    } else if (map[code]) {
      const reason = params.get('reason');
      util.toast(map[code] + (reason ? '（' + reason + '）' : ''), 3200);
    }
    // 清理 URL，避免刷新重复提示
    const url = new URL(location.href);
    url.searchParams.delete('wechat');
    url.searchParams.delete('reason');
    history.replaceState({ eatPage: Pager.index }, '', url.pathname + url.search);
  }

  function updateSourceBadge(data) {
    const badge = document.getElementById('sourceBadge');
    if (!badge) return;
    if (data.demo) {
      badge.textContent = '演示数据 · 共 ' + (data.total || 0) + ' 家';
    } else {
      badge.textContent = '数据来源：' + (data.sourceLabel || data.source) + ' · 实时拉取 ' + (data.total || 0) + ' 家';
    }
  }

  /* ---------------- 防丢提醒 ---------------- */
  function guardUnload() {
    window.addEventListener('beforeunload', function (event) {
      const prefs = Store.prefs();
      const lastChange = prefs.lastChangeAt || 0;
      const lastExport = prefs.lastExportAt || 0;
      if (Store.data.checkins.length && lastChange > lastExport) {
        event.preventDefault();
        event.returnValue = '打卡记录还没导出备份，确定离开吗？';
        return event.returnValue;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', App.init);
})();
