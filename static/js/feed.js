/* 首页瀑布流：双列马赛克、懒加载、分页、口味微调
   性能要点：
   1. 列宽只在渲染开始时读一次，避免循环内强制回流；
   2. 复用已存在的卡片 DOM（按 id），筛选切换不重新下载图片、不重放动画；
   3. 首屏 12 张，滚动到底再追加 8 张。 */
(function () {
  'use strict';

  const PAGE_SIZE = 8;
  const FIRST_BATCH = 12;
  const CARD_BODY_HEIGHT = 78;

  const Feed = {
    items: [],
    filtered: [],
    visible: FIRST_BATCH,
    heights: [0, 0],
    colWidth: 180,
    observer: null,
    firstRenderDone: false,

    init() {
      this.colA = document.getElementById('colA');
      this.colB = document.getElementById('colB');
      this.statusEl = document.getElementById('feedStatus');
      this.sentinel = document.getElementById('feedSentinel');
      this.pane = document.getElementById('pane-home');
      this.armed = false;
      this.bindObserver();
    },

    bindObserver() {
      const self = this;
      if (this.observer) this.observer.disconnect();
      if (this.pane) {
        // 只有用户真的滑过，才允许「触底自动加载」；
        // 否则哨兵一直可见会让 3→5→8km 连续触发，一次都没滑就把所有档位拉完
        this.pane.addEventListener('scroll', function () { self.armed = true; }, { passive: true });
      }
      if (!('IntersectionObserver' in window)) return;
      this.observer = new IntersectionObserver(function (entries) {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (!self.armed && self.canScroll()) return;
        self.loadMore();
      }, { root: self.pane, rootMargin: '280px 0px' });
      if (this.sentinel) this.observer.observe(this.sentinel);
    },

    /** 内容比容器高才叫「能滚动」；短列表允许自动补一屏，不然永远滑不动 */
    canScroll() {
      if (!this.pane) return false;
      return this.pane.scrollHeight > this.pane.clientHeight + 8;
    },

    setItems(items) {
      this.items = items || [];
      this.render();
    },

    /** 当前筛选结果，供随机抽店复用，避免二次过滤 */
    currentPool() {
      return this.filtered;
    },

    render() {
      if (!this.colA || !this.colB) return;

      // 未定位：等待真实定位（首次进入不预设地址）
      if (!App.state.location) {
        this.colA.innerHTML = '';
        this.colB.innerHTML = '';
        this.renderLocating();
        return;
      }

      // 1) 先收集旧卡片，稍后按 id 复用
      const existing = new Map();
      [this.colA, this.colB].forEach((col) => {
        Array.from(col.children).forEach((card) => {
          if (card.dataset.id) existing.set(card.dataset.id, card);
        });
      });

      // 2) 只读一次列宽（避免循环内 layout thrash）
      this.colWidth = this.colA.clientWidth || 180;

      // 3) 计算筛选结果（口味微调，不污染原对象）
      const list = this.personalize(Filters.apply(this.items, {
        weekend: App.state.weekend,
        submode: App.state.weekendSubmode,
        keyword: App.state.keyword
      }));
      this.filtered = list;

      const count = document.getElementById('condCount');
      if (count) count.textContent = '共 ' + list.length + ' 家';

      this.colA.innerHTML = '';
      this.colB.innerHTML = '';
      this.heights = [0, 0];

      if (!list.length) {
        this.visible = 0;
        this.renderEmpty();
        return;
      }

      if (this.statusEl) this.statusEl.innerHTML = '';
      this.visible = Math.min(FIRST_BATCH, list.length);
      this.armed = false;
      this.appendRange(0, this.visible, existing);
      this.firstRenderDone = true;
    },

    /** 按口味对距离做轻微修正：effective = distance / (1 + 0.35 × 菜系偏好占比) */
    personalize(list) {
      const stats = Store.stats();
      if (!stats.total) return list.slice();
      const affinity = new Map();
      list.forEach((item) => {
        affinity.set(item.id, (stats.cuisines[item.cuisine] || 0) / stats.total);
      });
      return list.slice().sort((a, b) => {
        const da = (a.distance || 0) / (1 + 0.35 * affinity.get(a.id));
        const db = (b.distance || 0) / (1 + 0.35 * affinity.get(b.id));
        return da - db;
      });
    },

    appendRange(from, to, existing) {
      for (let i = from; i < to; i++) {
        const item = this.filtered[i];
        const target = this.heights[0] <= this.heights[1] ? 0 : 1;
        const col = target === 0 ? this.colA : this.colB;

        const signature = this.signatureOf(item);
        let card = existing && existing.get(item.id);
        if (card && card.dataset.sig !== signature) card = null;
        if (card) {
          existing.delete(item.id);
        } else {
          card = this.buildCard(item, i, signature);
        }
        col.appendChild(card);
        this.heights[target] += Number(card.dataset.height) || CARD_BODY_HEIGHT;
      }

      // 到底/加载中提示由 showNoMore / setLoadingMore 统一控制，这里不覆盖
    },

    /**
     * 追加「更远一档」的店：id 去重 + 按距离升序 + 只追加不重排已渲染卡片。
     * 返回真正新增并可见的条数（0 表示这一档没有新店）。
     */
    appendItems(fresh) {
      if (!fresh || !fresh.length) return 0;
      const existingIds = new Set(this.items.map((item) => item.id));
      const add = fresh.filter((item) => !existingIds.has(item.id));
      if (!add.length) return 0;

      this.items = this.items.concat(add);

      // 新店过一遍当前筛选，再用与首屏相同的口味修正排序，最后按距离升序追加
      const passed = this.personalize(Filters.apply(add, {
        weekend: App.state.weekend,
        submode: App.state.weekendSubmode,
        keyword: App.state.keyword
      }).sort((a, b) => (a.distance || 0) - (b.distance || 0)));

      if (!passed.length) return 0;

      this.filtered = this.filtered.concat(passed);
      const from = this.visible;
      this.visible = this.filtered.length;
      this.appendRange(from, this.visible, null);
      return passed.length;
    },

    setLoadingMore(show) {
      if (!this.statusEl) return;
      if (show) {
        this.statusEl.innerHTML = '<span class="feed-loading">正在加载更远的店…</span>';
      } else if (this.statusEl.querySelector('.feed-loading')) {
        this.statusEl.innerHTML = '';
      }
    },

    showNoMore() {
      if (!this.statusEl) return;
      const p = App.state.pagination || {};
      const radius = p.radius || 3000;
      if (radius >= 8000) {
        this.statusEl.textContent = '已经到底啦 · 附近 8km 内的店都在这了';
        return;
      }
      const nextFilter = radius < 5000 ? 5000 : 0;
      const nextLabel = nextFilter === 0 ? '不限距离' : '看看 ' + (nextFilter / 1000) + 'km 内的';
      this.statusEl.innerHTML =
        '<span>已经到底啦 · 附近 ' + (radius / 1000) + 'km 内的店都在这了</span>' +
        '<button class="link-btn feed-more" type="button">' + nextLabel + '</button>';
      const btn = this.statusEl.querySelector('.feed-more');
      if (btn) btn.addEventListener('click', () => App.changeDistance(nextFilter));
    },

    clearStatus() {
      if (this.statusEl) this.statusEl.innerHTML = '';
    },

    loadMore() {
      const p = App.state.pagination || {};
      if (p.loading) return; // 加载中：防重复触发

      // 1) 本地还有未渲染的，先渲染（不触网，快速响应）
      if (this.visible < this.filtered.length) {
        const from = this.visible;
        this.visible = Math.min(this.filtered.length, this.visible + PAGE_SIZE);
        this.appendRange(from, this.visible, null);
        return;
      }

      // 2) 本地渲染完，按游标往后翻一页；要等下一次滑动才会再触发
      this.armed = false;
      App.loadMoreByRadius();
    },

    signatureOf(item) {
      // 数据刷新后（距离/评分/人均变化）需要重建卡片，纯筛选变化则复用
      return [item.id, item.distance, item.rating, item.avgPrice, item.isNew, item.hasDeal].join('|');
    },

    ratioOf(item) {
      const seed = String(item.id || '').split('')
        .reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
      const options = [1.18, 1.02, 1.3, 0.94, 1.12];
      return options[seed % options.length];
    },

    buildCard(item, index, signature) {
      const util = App.util;
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.id = item.id;
      card.dataset.sig = signature || this.signatureOf(item);

      const ratio = this.ratioOf(item);
      const height = ratio * this.colWidth + CARD_BODY_HEIGHT;
      card.dataset.height = String(Math.round(height));
      // 仅首屏播放进入动画，筛选/分页时不再重放
      if (!this.firstRenderDone && index < FIRST_BATCH) {
        card.classList.add('card--enter');
        card.style.animationDelay = Math.min(index, 8) * 26 + 'ms';
      }

      const badge = Filters.badgeFor(item);
      const status = App.util.openState(item);
      const closed = status.known && !status.open;
      if (closed) card.classList.add('is-closed');
      const meta = [item.cuisine, (item.tags || [])[0]].filter(Boolean).join(' · ');
      const cover = util.imgUrl(item.cover || (item.gallery || [])[0], item.cuisine);
      const ratingHtml = item.rating
        ? '<span class="card-rating"><svg class="ico"><use href="#i-star"></use></svg>' + item.rating.toFixed(1) + '</span>'
        : '<span class="card-rating is-empty">暂无评分</span>';
      const priceText = item.avgPrice ? '¥' + item.avgPrice : '人均待补充';
      const distance = item.distanceLabel || (item.distance ? (item.distance / 1000).toFixed(1) + 'km' : '');
      const srcset = util.srcset(cover);

      card.innerHTML =
        '<div class="card-media" style="padding-top:' + (ratio * 100).toFixed(0) + '%">' +
        (badge ? '<span class="badge-mint">' + badge + '</span>' : '') +
        (closed ? '<span class="card-closed">已打烊</span>' : '') +
        '<picture>' + util.webpSource(cover, '(max-width: 520px) 45vw, 200px') +
        '<img loading="' + (index < 2 ? 'eager' : 'lazy') + '" decoding="async"' +
        (index === 0 ? ' fetchpriority="high"' : '') +
        ' src="' + util.escapeHtml(cover) + '"' +
        (srcset ? ' srcset="' + util.escapeHtml(srcset) + '" sizes="(max-width: 520px) 45vw, 200px"' : '') +
        ' alt="' + util.escapeHtml(item.name) + '"' +
        ' style="object-position:' + util.escapeHtml(item.photoPos || '50% 50%') + '">' +
        '</picture></div>' +
        '<div class="card-body">' +
        '<h3 class="card-name">' + util.escapeHtml(item.name) + '</h3>' +
        '<p class="card-meta">' + util.escapeHtml(meta) + '</p>' +
        '<div class="card-bottom">' + ratingHtml +
        (item.hasDeal ? '<span class="card-deal">团购</span>' : '') +
        '<span class="card-price">' + util.escapeHtml([distance, priceText].filter(Boolean).join(' · ')) + '</span>' +
        '</div></div>';

      const img = card.querySelector('img');
      img.addEventListener('error', function () {
        this.src = util.imgUrl('', item.cuisine);
        this.removeAttribute('srcset');
        this.onerror = null;
      }, { once: true });

      card.addEventListener('click', () => Detail.open(item));
      return card;
    },

    renderLocating() {
      if (!this.statusEl) return;
      this.statusEl.innerHTML =
        '<div class="empty-state">' +
        '<div class="emoji">📍</div>' +
        '<h3>正在获取你的位置…</h3>' +
        '<p>允许浏览器定位，就能看到你附近的美食；也可以手动选个位置。</p>' +
        '<button class="btn-outline" id="locateNowBtn" type="button">手动选位置</button>' +
        '</div>';
      const btn = document.getElementById('locateNowBtn');
      if (btn) btn.addEventListener('click', () => App.openLocationSheet());
    },

    renderEmpty() {
      if (!this.statusEl) return;
      const weekendOn = App.state.weekend;
      const solo = App.state.weekendSubmode !== 'group';

      this.statusEl.innerHTML =
        '<div class="empty-state">' +
        '<div class="emoji">' + (weekendOn ? '🍲' : '🥢') + '</div>' +
        '<h3>' + (weekendOn
          ? (solo ? '周末 solo 没筛到合适的店' : '周末聚餐没筛到合适的店')
          : '这些条件下暂时没有店') + '</h3>' +
        '<p>' + (weekendOn
          ? (solo
            ? '只推适合一个人的店，试试切到「一起聚餐」，或放宽距离与人均。'
            : '只推适合聚餐的店，试试切到「一个人吃」，或放宽距离与人均。')
          : '把筛选放宽一点，或者换个菜系看看。') + '</p>' +
        '<button class="btn-outline" id="clearFiltersBtn" type="button">清空筛选</button>' +
        '</div>';

      const btn = document.getElementById('clearFiltersBtn');
      if (btn) {
        btn.addEventListener('click', () => {
          if (weekendOn) App.setWeekend(false, true);
          Filters.state.cuisine = null;
          Filters.state.priceMax = null;
          Filters.state.distance = 3000;
          Filters.state.perCapita = null;
          Filters.state.rating = null;
          Filters.state.openOnly = false;
          Filters.renderCuisine();
          Filters.renderFilterChips();
          Filters.renderCond();
          App.applyFilters();
        });
      }
    },

    showError(error) {
      const util = App.util;
      if (!this.statusEl) return;
      this.colA.innerHTML = '';
      this.colB.innerHTML = '';
      this.statusEl.innerHTML =
        '<div class="feed-error">' +
        '<div class="emoji">🌀</div>' +
        '<h3>' + util.escapeHtml(error.message || '数据没拉到') + '</h3>' +
        '<p>' + util.escapeHtml(error.hint || '检查一下网络，或手动输入城市 + 商圈') + '</p>' +
        '<div class="row">' +
        '<button class="btn-outline" id="retryBtn" type="button">重试一次</button>' +
        '<button class="btn-outline btn-outline--muted" id="manualBtn2" type="button">手动输入商圈</button>' +
        '</div></div>';
      const retry = document.getElementById('retryBtn');
      if (retry) retry.addEventListener('click', () => App.reloadData());
      const manual = document.getElementById('manualBtn2');
      if (manual) manual.addEventListener('click', () => App.openLocationSheet());
    }
  };

  window.Feed = Feed;
})();
