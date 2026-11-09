/* 随机抽店：先应用全部筛选，再从池中加权随机（已打卡权重 0.3），支持摇一摇 */
(function () {
  'use strict';

  const Draw = {
    overlay: null,
    lastShake: 0,
    last: null,

    init() {
      this.overlay = document.getElementById('drawOverlay');
      const self = this;
      if (this.overlay) {
        this.overlay.addEventListener('click', (event) => {
          if (event.target === self.overlay) self.close();
        });
      }
      const btn = document.getElementById('drawBtn');
      if (btn) btn.addEventListener('click', () => self.trigger());
      this.bindShake();
    },

    pool() {
      // 复用瀑布流已按当前筛选算好的结果；尚未渲染时再兜底计算一次
      if (Feed.filtered && Feed.filtered.length) return Feed.filtered;
      return Filters.apply(Feed.items, {
        weekend: App.state.weekend,
        submode: App.state.weekendSubmode,
        keyword: App.state.keyword
      });
    },

    /** 加权随机：已打卡 0.3、偏好菜系加成、高分新店 1.1；雷达扫描复用同一套规则 */
    weightedPick(pool) {
      if (!pool || !pool.length) return null;
      const stats = Store.stats();
      const total = stats.total || 1;
      const checked = new Set((Store.data.checkins || []).map((item) => item.id));
      const weights = pool.map((item) => {
        let weight = checked.has(item.id) ? 0.3 : 1.0;
        const affinity = (stats.cuisines[item.cuisine] || 0) / total;
        weight *= 1 + 0.5 * affinity;
        if (item.isNew && (item.rating || 0) >= 4.5) weight *= 1.1;
        return Math.max(weight, 0.001);
      });
      const sum = weights.reduce((a, b) => a + b, 0);
      let ticket = Math.random() * sum;
      for (let i = 0; i < pool.length; i++) {
        ticket -= weights[i];
        if (ticket <= 0) return pool[i];
      }
      return pool[pool.length - 1];
    },

    pick() {
      return this.weightedPick(this.pool());
    },

    trigger() {
      const pool = this.pool();
      if (!pool.length) {
        App.util.toast('当前条件下没有可抽的店，放宽一点筛选试试');
        return;
      }
      App.util.haptic([14, 24, 14]);
      const item = this.pick();
      if (item) this.show(item, pool.length);
    },

    show(item, poolSize) {
      const util = App.util;
      this.last = item;
      const overlay = this.overlay;
      if (!overlay) return;

      const review = (item.reviews && item.reviews[0]) ? item.reviews[0] : null;
      const summary = review ? review.text : '点进去看看实拍和地图公开评价摘要。';
      const cover = util.imgUrl(item.cover || (item.gallery || [])[0], item.cuisine);
      const coverSet = util.srcset(cover);
      const badge = Filters.badgeFor(item);

      overlay.innerHTML =
        '<div class="draw-card">' +
        '<p class="draw-kicker">从 ' + poolSize + ' 家里抽到</p>' +
        '<h2 class="draw-title">今天就吃这家</h2>' +
        '<div class="draw-media">' +
        (badge ? '<span class="badge-mint">' + badge + '</span>' : '') +
        '<picture>' + util.webpSource(cover, '340px') +
        '<img src="' + util.escapeHtml(cover) + '"' + (coverSet ? ' srcset="' + util.escapeHtml(coverSet) + '" sizes="340px"' : '') +
        ' alt="' + util.escapeHtml(item.name) + '">' +
        '</picture></div>' +
        '<h3 class="draw-name">' + util.escapeHtml(item.name) + '</h3>' +
        '<p class="draw-meta">' + (item.rating ? '★ ' + item.rating.toFixed(1) : '暂无评分') +
        ' · ' + util.escapeHtml(item.cuisine) +
        ' · ' + (item.avgPrice ? '人均 ¥' + item.avgPrice : '人均待补充') +
        ' · ' + util.escapeHtml(item.distanceLabel || '') + '</p>' +
        '<p class="draw-address">' + util.escapeHtml(item.address || '') + '</p>' +
        '<p class="draw-review">“' + util.escapeHtml(summary) + '”</p>' +
        '<div class="draw-actions">' +
        '<button class="btn-outline" id="drawAgain" type="button">再抽一次</button>' +
        '<button class="btn-primary" id="drawGo" type="button">就吃这家</button>' +
        '</div>' +
        '<button class="draw-share" id="drawShare" type="button">' +
        '<svg class="ico"><use href="#i-share"></use></svg> 分享给朋友一起决定' +
        '</button>' +
        '<p class="draw-hint">已打卡的店不排除，但被抽中的概率降到普通店的 30%</p>' +
        '</div>';

      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('no-scroll');

      const again = document.getElementById('drawAgain');
      if (again) again.addEventListener('click', () => this.trigger());
      const go = document.getElementById('drawGo');
      if (go) go.addEventListener('click', () => {
        this.close();
        Detail.open(item);
      });
      const share = document.getElementById('drawShare');
      if (share) share.addEventListener('click', () => this.share(item));
    },

    share(item) {
      const util = App.util;
      const url = location.origin + '/?store=' + encodeURIComponent(item.id);
      const text = '今天吃啥帮我抽到了：' + item.name +
        (item.avgPrice ? '（人均 ¥' + item.avgPrice + '）' : '') +
        (item.distanceLabel ? '，' + item.distanceLabel : '');
      if (navigator.share) {
        navigator.share({ title: '今天吃这家', text: text, url: url }).catch(() => {});
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text + '\n' + url).then(
          () => util.toast('文案和链接已复制，发给朋友吧', 2400),
          () => util.toast(url, 3000)
        );
        return;
      }
      util.toast(url, 3000);
    },

    close() {
      if (!this.overlay) return;
      this.overlay.classList.remove('is-open');
      this.overlay.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('no-scroll');
    },

    bindShake() {
      if (!window.DeviceMotionEvent) return;
      const self = this;

      const enable = () => {
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
          DeviceMotionEvent.requestPermission().catch(() => {});
        }
      };
      document.addEventListener('click', enable, { once: true });

      window.addEventListener('devicemotion', (event) => {
        const acc = event.accelerationIncludingGravity;
        if (!acc) return;
        const magnitude = Math.sqrt((acc.x || 0) * (acc.x || 0) + (acc.y || 0) * (acc.y || 0) + (acc.z || 0) * (acc.z || 0));
        if (magnitude > 26 && Date.now() - self.lastShake > 1600) {
          self.lastShake = Date.now();
          if (App.state.page === 0 && !App.state.checkinOpen) self.trigger();
        }
      }, { passive: true });
    }
  };

  window.Draw = Draw;
})();
