/* P3 内嵌导航：路线、时长、文字指引、原生地图跳转 */
(function () {
  'use strict';

  const MODE_LABEL = { walking: '步行', cycling: '骑行', driving: '驾车' };

  const Nav = {
    route: null,

    init() {
      const self = this;
      document.querySelectorAll('[data-zoom]').forEach((btn) => {
        btn.addEventListener('click', () => {
          // 高德与 SVG 两条渲染路径都走 MapView：按钮不再只在无 Key 时有效
          MapView.zoom(document.getElementById('navMap'), btn.dataset.zoom === 'in' ? 1 : -1);
        });
      });
      const locate = document.getElementById('navLocate');
      if (locate) {
        locate.addEventListener('click', () => {
          if (!self.route) return;
          MapView.reset(document.getElementById('navMap'));
        });
      }
      const native = document.getElementById('nativeNavBtn');
      if (native) native.addEventListener('click', () => self.openNative());
      const play = document.getElementById('goPlayBtn');
      if (play) play.addEventListener('click', () => Play.open());
      const refresh = document.getElementById('navRefresh');
      if (refresh) refresh.addEventListener('click', () => App.goHome(true));
      const draw = document.getElementById('navDraw');
      if (draw) draw.addEventListener('click', () => Draw.trigger());
    },

    options() {
      const item = App.state.current || {};
      return {
        store: item,
        me: App.state.location,
        route: this.route ? this.route.polyline : null,
        featuredSegment: this.route ? this.route.featuredSegment : null,
        featuredLabel: this.route && this.route.featuredStreet ? this.route.featuredStreet.name : '',
        showMeLabel: true,
        showStoreLabel: true,
        padding: 56,
        paddingBottom: 290
      };
    },

    async open(mode) {
      const item = App.state.current;
      if (!item) return;
      App.state.mode = mode || 'walking';
      App.navigateTo(2);

      document.getElementById('navModeLabel').textContent = MODE_LABEL[App.state.mode];
      document.getElementById('navSteps').textContent = '正在为你规划路线…';

      const location = App.state.location || {};
      try {
        const data = await API.route({
          from_lat: location.lat,
          from_lng: location.lng,
          to_lat: item.lat,
          to_lng: item.lng,
          mode: App.state.mode
        });
        this.route = data.route;
        App.state.route = data.route;
        this.render(data.route, item);
      } catch (e) {
        document.getElementById('navSteps').textContent = e.message || '路线没拉到，稍后再试';
        App.util.toast(e.message || '路线没拉到');
      }
    },

    render(route, item) {
      const util = App.util;
      document.getElementById('navMinutes').textContent = route.duration;
      document.getElementById('navDistance').textContent =
        (route.distance / 1000).toFixed(1) + 'km';
      document.getElementById('navModeLabel').textContent = MODE_LABEL[route.mode] || '步行';

      const steps = route.steps || [];
      let text = steps.slice(0, 2).map((step) => step.instruction).join('，');
      if (route.featuredStreet) {
        text += '，途经' + route.featuredStreet.name + '，暖橘路段更适合顺路逛一逛。';
      }
      if (!text) text = '沿当前道路直行，按地图路线前往目的地。';
      document.getElementById('navSteps').textContent = text;

      const mapEl = document.getElementById('navMap');
      if (mapEl) MapView.render(mapEl, this.options());
    },

    openNative() {
      const item = App.state.current;
      if (!item) return;
      const modeMap = { walking: 'walk', cycling: 'ride', driving: 'car' };
      const mode = modeMap[App.state.mode] || 'walk';
      const name = encodeURIComponent(item.name || '目的地');
      const url = 'https://uri.amap.com/navigation?to=' + item.lng + ',' + item.lat + ',' + name +
        '&mode=' + mode + '&coordinate=gaode&callnative=1&src=weekendeat';
      window.open(url, '_blank');
    }
  };

  window.Nav = Nav;
})();
