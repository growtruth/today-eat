/* P4 饭后游玩：顺路点位、顺路度、特色街巷权重、右滑回首页 */
(function () {
  'use strict';

  const Play = {
    data: null,
    item: null,
    budget: 0,

    init() {
      const box = document.getElementById('playBudget');
      if (box) {
        box.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-minutes]');
          if (!btn) return;
          this.budget = Number(btn.dataset.minutes) || 0;
          Array.from(box.querySelectorAll('[data-minutes]')).forEach((item) => {
            const on = Number(item.dataset.minutes) === this.budget;
            item.classList.toggle('is-on', on);
            item.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          if (this.data && this.item) this.render(this.data, this.item);
        });
      }

      // 地图控件：高德与 SVG 两条路径都走 MapView
      document.querySelectorAll('[data-play-zoom]').forEach((btn) => {
        btn.addEventListener('click', () => {
          MapView.zoom(document.getElementById('playMap'), btn.dataset.playZoom === 'in' ? 1 : -1);
        });
      });
      const reset = document.getElementById('playMapReset');
      if (reset) {
        reset.addEventListener('click', () => {
          MapView.reset(document.getElementById('playMap'));
          App.util.toast('已回到店铺视野');
        });
      }
    },

    async open() {
      const item = App.state.current;
      if (!item) return;
      App.navigateTo(3);
      const box = document.getElementById('playCards');
      if (box) box.innerHTML = '<p style="font-size:11.5px;color:#B4A79E;padding:8px 0">正在挑顺路的去处…</p>';

      try {
        const data = await API.playSpots({
          lat: item.lat,
          lng: item.lng,
          store_id: item.id,
          name: item.name
        });
        this.data = data;
        this.render(data, item);
      } catch (e) {
        if (box) box.innerHTML = '<p style="font-size:11.5px;color:#B4A79E;padding:8px 0">' +
          (e.message || '点位没拉到，稍后再试') + '</p>';
        App.util.toast(e.message || '点位没拉到');
      }
    },

    render(data, item) {
      const util = App.util;
      this.data = data;
      this.item = item;
      const all = data.items || [];
      // 按可用时间过滤：0 表示不限
      const items = this.budget
        ? all.filter((spot) => (spot.walkMinutes || 0) <= this.budget)
        : all;

      const duration = document.getElementById('playDuration');
      if (duration) {
        const mode = App.state.mode === 'cycling' ? '骑行' : (App.state.mode === 'driving' ? '驾车' : '步行');
        if (!items.length) {
          duration.textContent = '暂无点位';
        } else {
          const total = items.slice(0, 2).reduce((sum, spot) => sum + (spot.walkMinutes || 0), 0);
          duration.textContent = mode + ' ' + Math.max(5, total + 4) + ' 分钟';
        }
      }

      const box = document.getElementById('playCards');
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<p class="play-empty">这个时间内没有顺路的去处，放宽到 1 小时试试。</p>';
      }
      items.forEach((spot) => {
        const card = document.createElement('article');
        card.className = 'spot-card';
        const image = spot.image ? util.imgUrl(spot.image) : '';
        const media = spot.image
          ? '<picture>' + util.webpSource(image, '50vw') +
            '<img loading="lazy" src="' + util.escapeHtml(image) + '" alt="' + util.escapeHtml(spot.name) + '"></picture>'
          : '<span class="emoji">' + this.emojiOf(spot.kind) + '</span>';
        const sub = (spot.featured ? '在' + spot.featuredStreet + '上 · ' : '') +
          '步行 ' + spot.walkMinutes + ' 分钟';
        card.innerHTML =
          '<div class="spot-media">' + media +
          '<span class="badge-mint">' + util.escapeHtml(spot.type) + '</span></div>' +
          '<div class="spot-body">' +
          '<h3 class="spot-title">' + util.escapeHtml(spot.name) + '</h3>' +
          '<p class="spot-sub">' + util.escapeHtml(sub) + '</p>' +
          '<div class="spot-foot"><span class="spot-smooth">顺路度 ' + spot.smoothness + '%</span>' +
          '<span class="spot-rank">第 ' + spot.rank + ' 顺路</span></div>' +
          '</div>';
        card.addEventListener('click', () => this.openSpot(spot));
        box.appendChild(card);
      });

      const mapEl = document.getElementById('playMap');
      const me = App.state.location;
      const navRoute = App.state.route;
      const route = navRoute && navRoute.polyline ? navRoute.polyline : null;
      MapView.render(mapEl, {
        store: item,
        me: me,
        spots: items,
        route: route,
        featuredSegment: navRoute ? navRoute.featuredSegment : null,
        featuredLabel: navRoute && navRoute.featuredStreet ? navRoute.featuredStreet.name : '',
        showStoreLabel: true,
        showMeLabel: false,
        showSpotLabels: true,
        spotLabelLimit: 2,
        padding: 40,
        onSpot: (spot) => this.openSpot(spot)
      });
    },

    openSpot(spot) {
      const util = App.util;
      App.util.openSheet({
        title: spot.name,
        subtitle: spot.type + ' · ' + spot.kind,
        body: '<p style="font-size:13px;line-height:1.8;color:#4A3F3A">' +
          util.escapeHtml(spot.desc || '暂无简介') + '</p>' +
          '<p style="margin-top:10px;font-size:11px;color:#9B8E86">步行 ' + spot.walkMinutes +
          ' 分钟 · 绕行 ' + spot.detour + ' 米 · 顺路度 ' + spot.smoothness + '%' +
          (spot.featured ? ' · 途经' + util.escapeHtml(spot.featuredStreet) : '') + '</p>',
        actions: [{ label: '知道了', variant: 'ghost' }]
      });
    },

    emojiOf(kind) {
      const map = { 书店: '📚', 咖啡: '☕', 甜品: '🍰', 烧烤: '🍢', 公园: '🌳', 演出: '🎭', 展览: '🖼️', 小店: '🧺' };
      return map[kind] || '📍';
    }
  };

  window.Play = Play;
})();
