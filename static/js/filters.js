/* 五步筛选：菜系 → 价格 → 距离 → 人均 → 评分（顺序固定，改动即时生效） */
(function () {
  'use strict';

  const CUISINES = ['火锅', '日料', '烧烤', '甜品', '咖啡', '奶茶', '小吃', '川菜', '西餐'];
  const DRINK = ['甜品', '咖啡', '奶茶'];

  const TIERS = {
    main: [
      { label: '100 内', min: 0, max: 100 },
      { label: '100-200', min: 100, max: 200 },
      { label: '200-300', min: 200, max: 300 },
      { label: '300+', min: 300, max: null }
    ],
    drink: [
      { label: '50 内', min: 0, max: 50 },
      { label: '50-70', min: 50, max: 70 },
      { label: '70-100', min: 70, max: 100 },
      { label: '100+', min: 100, max: null }
    ]
  };

  const DISTANCES = [
    { value: 1000, label: '1km 内' },
    { value: 3000, label: '3km 内' },
    { value: 5000, label: '5km 内' },
    { value: 0, label: '不限' }
  ];

  const RATINGS = [
    { value: 3.5, label: '3.5 分以上' },
    { value: 4.0, label: '4.0 分以上' },
    { value: 4.5, label: '4.5 分以上' },
    { value: null, label: '不限' }
  ];

  const Filters = {
    state: {
      cuisine: null,
      priceMax: null,
      distance: 3000,
      perCapita: null,
      rating: null,
      openOnly: false
    },

    init() {
      this.renderCuisine();
      this.renderFilterChips();
      this.renderCond();
      this.bind();
    },

    bind() {
      const self = this;
      const row = document.getElementById('filterRow');
      row.addEventListener('click', function (event) {
        const toggle = event.target.closest('[data-toggle]');
        if (toggle) {
          if (toggle.dataset.toggle === 'openOnly') {
            self.state.openOnly = !self.state.openOnly;
            self.renderFilterChips();
            self.renderCond();
            App.applyFilters();
          }
          return;
        }
        const btn = event.target.closest('[data-filter]');
        if (!btn) return;
        self.openPanel(btn.dataset.filter);
      });
    },

    category() {
      if (this.state.cuisine && DRINK.indexOf(this.state.cuisine) >= 0) return 'drink';
      return 'main';
    },

    tiers() {
      return TIERS[this.category()];
    },

    /* ---------------- 菜系 ---------------- */
    renderCuisine() {
      const row = document.getElementById('cuisineRow');
      if (!row) return;
      const self = this;
      row.innerHTML = '';
      CUISINES.forEach((cuisine) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip' + (self.state.cuisine === cuisine ? ' is-on' : '');
        btn.dataset.cuisine = cuisine;
        btn.setAttribute('aria-pressed', self.state.cuisine === cuisine ? 'true' : 'false');
        btn.innerHTML = App.util.escapeHtml(cuisine) +
          (self.state.cuisine === cuisine ? '<svg class="ico"><use href="#i-check"></use></svg>' : '');
        btn.addEventListener('click', () => {
          const prevCategory = self.category();
          self.state.cuisine = self.state.cuisine === cuisine ? null : cuisine;
          // 正餐 ↔ 甜点/饮品 的分档规则不同，切换时清空人均，避免 200-300 变成 70-100
          if (self.category() !== prevCategory) self.state.perCapita = null;
          self.renderCuisine();
          self.renderFilterChips();
          self.renderCond();
          App.applyFilters();
        });
        row.appendChild(btn);
      });
    },

    /* ---------------- 筛选条 ---------------- */
    renderFilterChips() {
      const row = document.getElementById('filterRow');
      if (!row) return;
      const f = this.state;
      const price = f.priceMax ? '¥' + f.priceMax + ' 内' : '价格不限';
      const distance = DISTANCES.filter((d) => d.value === f.distance)[0].label;
      const tier = f.perCapita != null ? this.tiers()[f.perCapita] : null;
      const perCapita = tier ? '人均 ' + tier.label : '人均';
      const rating = f.rating ? f.rating.toFixed(1) + ' 分以上' : '评分';

      const map = {
        price: { text: price, on: !!f.priceMax },
        distance: { text: distance, on: f.distance !== 3000 },
        perCapita: { text: perCapita, on: f.perCapita != null },
        rating: { text: rating, on: !!f.rating }
      };

      Array.from(row.querySelectorAll('[data-filter]')).forEach((btn) => {
        const info = map[btn.dataset.filter];
        btn.classList.toggle('is-on', info.on);
        const label = btn.querySelector('.chip-label');
        if (label) label.textContent = info.text;
      });

      const toggle = row.querySelector('[data-toggle="openOnly"]');
      if (toggle) {
        toggle.classList.toggle('is-on', !!f.openOnly);
        toggle.setAttribute('aria-pressed', f.openOnly ? 'true' : 'false');
      }
    },

    /* ---------------- 已选条件 ---------------- */
    renderCond() {
      const box = document.getElementById('condChips');
      if (!box) return;
      const f = this.state;
      const items = [];
      if (f.cuisine) {
        items.push({ label: f.cuisine, clear: () => { f.cuisine = null; this.renderCuisine(); } });
      }
      if (f.priceMax) {
        items.push({ label: '≤¥' + f.priceMax, clear: () => { f.priceMax = null; } });
      }
      if (f.distance !== 3000) {
        const d = DISTANCES.filter((x) => x.value === f.distance)[0];
        items.push({ label: d.label, clear: () => { App.changeDistance(3000); } });
      }
      if (f.perCapita != null) {
        const t = this.tiers()[f.perCapita];
        items.push({ label: '人均 ' + t.label, clear: () => { f.perCapita = null; } });
      }
      if (f.rating) {
        items.push({ label: f.rating.toFixed(1) + '+', clear: () => { f.rating = null; } });
      }
      if (f.openOnly) {
        items.push({ label: '营业中', clear: () => { f.openOnly = false; } });
      }

      box.innerHTML = '';
      if (!items.length) {
        const hint = document.createElement('span');
        hint.style.fontSize = '11px';
        hint.style.color = '#B4A79E';
        hint.textContent = '还没加筛选，先随便看看';
        box.appendChild(hint);
        return;
      }

      const self = this;
      items.forEach((item) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cond-chip';
        chip.innerHTML = App.util.escapeHtml(item.label) + '<i>×</i>';
        chip.addEventListener('click', (event) => {
          event.stopPropagation();
          item.clear();
          self.renderFilterChips();
          self.renderCond();
          App.applyFilters();
        });
        box.appendChild(chip);
      });
    },

    /* ---------------- 弹层 ---------------- */
    openPanel(type) {
      const self = this;
      const body = document.createElement('div');
      const titles = { price: '价格区间', distance: '距离档位', perCapita: '人均区间', rating: '评价星级' };
      const subtitles = {
        price: '按人均预算上限筛选，拖动滑块即可',
        distance: '以当前位置为圆心',
        perCapita: '按品类分档，写死规则',
        rating: '只保留达到分数线的店'
      };

      if (type === 'price') {
        body.appendChild(this.buildPrice());
      } else if (type === 'distance') {
        body.appendChild(this.buildOptions(DISTANCES, this.state.distance, (value) => {
          App.changeDistance(value);
        }));
      } else if (type === 'perCapita') {
        const tiers = this.tiers();
        const options = tiers.map((tier, index) => ({ value: index, label: tier.label }));
        body.appendChild(this.buildOptions(options, this.state.perCapita, (value) => {
          this.state.perCapita = value;
          this.renderFilterChips();
          this.renderCond();
          App.applyFilters();
        }));
        const note = document.createElement('p');
        note.style.cssText = 'font-size:10.5px;color:#B4A79E;line-height:1.6';
        note.textContent = this.category() === 'drink'
          ? '当前为甜点/饮品分档：50 内 / 50-70 / 70-100 / 100+'
          : '当前为正餐分档：100 内 / 100-200 / 200-300 / 300+';
        body.appendChild(note);
      } else if (type === 'rating') {
        body.appendChild(this.buildOptions(RATINGS, this.state.rating, (value) => {
          this.state.rating = value;
          this.renderFilterChips();
          this.renderCond();
          App.applyFilters();
        }));
      }

      App.util.openSheet({
        title: titles[type],
        subtitle: subtitles[type],
        body: body,
        actions: [{ label: '看看结果', onClick: () => App.applyFilters() }]
      });
    },

    buildOptions(options, current, onPick) {
      const wrap = document.createElement('div');
      wrap.className = 'option-row';
      options.forEach((option) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option' + (String(option.value) === String(current) ? ' is-on' : '');
        btn.textContent = option.label;
        btn.addEventListener('click', () => {
          Array.from(wrap.children).forEach((child) => child.classList.remove('is-on'));
          btn.classList.add('is-on');
          onPick(option.value);
        });
        wrap.appendChild(btn);
      });
      return wrap;
    },

    buildPrice() {
      const self = this;
      const wrap = document.createElement('div');
      const maxValue = 300;
      const value = this.state.priceMax ? Math.min(maxValue, this.state.priceMax) : maxValue;
      wrap.innerHTML =
        '<div class="field-label"><span>人均预算上限</span>' +
        '<span><b id="priceValue">' + (this.state.priceMax ? '¥' + this.state.priceMax : '不限') + '</b></span></div>' +
        '<div class="range-wrap"><input id="priceRange" type="range" min="30" max="' + maxValue + '" step="10" value="' + value + '">' +
        '<div class="range-scale"><span>¥30</span><span>¥300+ 不限</span></div></div>' +
        '<div class="option-row" id="priceQuick" style="margin-top:6px"></div>';

      const quick = [
        { value: null, label: '不限' },
        { value: 50, label: '¥50' },
        { value: 100, label: '¥100' },
        { value: 150, label: '¥150' },
        { value: 200, label: '¥200' }
      ];
      const quickBox = wrap.querySelector('#priceQuick');
      quick.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option' + (String(item.value) === String(self.state.priceMax) ? ' is-on' : '');
        btn.textContent = item.label;
        btn.addEventListener('click', () => {
          Array.from(quickBox.children).forEach((child) => child.classList.remove('is-on'));
          btn.classList.add('is-on');
          self.state.priceMax = item.value;
          self.state._priceTouched = true;
          wrap.querySelector('#priceRange').value = item.value || maxValue;
          wrap.querySelector('#priceValue').textContent = item.value ? '¥' + item.value : '不限';
          self.renderFilterChips();
          self.renderCond();
          App.applyFilters();
        });
        quickBox.appendChild(btn);
      });

      const range = wrap.querySelector('#priceRange');
      range.addEventListener('input', () => {
        const v = Number(range.value);
        const isAll = v >= maxValue;
        self.state.priceMax = isAll ? null : v;
        wrap.querySelector('#priceValue').textContent = isAll ? '不限' : '¥' + v;
        Array.from(quickBox.children).forEach((child) => child.classList.remove('is-on'));
        self.renderFilterChips();
        self.renderCond();
        App.applyFilters();
      });
      return wrap;
    },

    /* ---------------- 应用 ---------------- */
    /** 一起聚餐：有包间、周末友好，或“适合拍照 + 人均 ≥80” */
    isGroupFriendly(item) {
      const tags = item.tags || [];
      if (tags.indexOf('周末友好') >= 0 || tags.indexOf('有包间') >= 0) return true;
      return tags.indexOf('适合拍照') >= 0 && (item.avgPrice || 0) >= 80;
    },

    /** 一个人吃：优先用数据标记；真实数据源无标记时按“无包间 + 饮品/人均≤100”推断 */
    isSoloFriendly(item) {
      if (typeof item.soloFriendly === 'boolean') return item.soloFriendly;
      const tags = item.tags || [];
      if (tags.indexOf('有包间') >= 0) return false;
      if (item.category === 'drink') return true;
      return (item.avgPrice || 0) <= 100;
    },

    isFriendlyFor(item, submode) {
      return submode === 'group' ? this.isGroupFriendly(item) : this.isSoloFriendly(item);
    },

    /** 卡片右上角小标：新店优先，其次按当前周末子模式显示“一人食 / 周末友好” */
    badgeFor(item) {
      if (item.isNew) return '新店';
      if (App.state.weekend && App.state.weekendSubmode === 'solo' && this.isSoloFriendly(item)) {
        return '一人食';
      }
      return this.isGroupFriendly(item) ? '周末友好' : '';
    },

    apply(items, options) {
      const opts = options || {};
      const f = this.state;
      const keyword = (opts.keyword || '').trim().toLowerCase();
      const tiers = this.tiers();

      return (items || []).filter((item) => {
        if (f.cuisine && item.cuisine !== f.cuisine) return false;
        if (f.priceMax && (item.avgPrice == null || item.avgPrice > f.priceMax)) return false;
        if (f.distance && (item.distance == null || item.distance > f.distance)) return false;
        if (f.perCapita != null) {
          const tier = tiers[f.perCapita];
          if (item.avgPrice == null) return false;
          if (tier.max != null && item.avgPrice > tier.max) return false;
          if (item.avgPrice < tier.min) return false;
        }
        if (f.rating && (item.rating == null || item.rating < f.rating)) return false;
        if (f.openOnly) {
          // 营业时间缺失时按“未知”放行，避免把没数据的店误判为打烊
          const status = App.util.openState(item);
          if (status.known && !status.open) return false;
        }
        if (opts.weekend && !this.isFriendlyFor(item, opts.submode || 'solo')) return false;
        if (keyword) {
          const blob = [item.name, item.cuisine, item.subCuisine, item.address, item.area].join(' ').toLowerCase();
          if (blob.indexOf(keyword) < 0) return false;
        }
        return true;
      });
    }
  };

  window.Filters = Filters;
})();
