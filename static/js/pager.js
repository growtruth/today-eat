/* 五页左右滑动容器：横向手势切换，P4 右滑直接回首页 */
(function () {
  'use strict';

  const Pager = {
    index: 0,
    max: 3,
    track: null,
    pager: null,
    startX: 0,
    startY: 0,
    dx: 0,
    axis: null,
    dragging: false,
    pointerId: null,

    init() {
      this.track = document.getElementById('track');
      this.pager = document.getElementById('pager');
      this.bind();
      this.apply(0, true);
    },

    paneWidth() {
      return this.pager ? this.pager.clientWidth : window.innerWidth;
    },

    apply(offsetPx, immediate) {
      // 用像素值代替 calc(%)：拖动时每帧少一次百分比解析，减少样式重算
      const width = this.paneWidth();
      const x = -this.index * width + (offsetPx || 0);
      if (immediate) this.track.classList.add('is-dragging');
      else this.track.classList.remove('is-dragging');
      this.track.style.transform = 'translate3d(' + x.toFixed(1) + 'px, 0, 0)';
      if (immediate) {
        void this.track.offsetWidth;
        requestAnimationFrame(() => this.track.classList.remove('is-dragging'));
      }
    },

    go(index, immediate, fromHistory) {
      const target = Math.max(0, Math.min(this.max, index));

      // 进入详情前必须有选中商家，否则会出现空白页
      if (target === 1 && window.App && !window.App.state.current) {
        const first = document.querySelector('#feed .card');
        if (first) {
          first.click();
          return;
        }
        if (window.App.util) window.App.util.toast('先挑一家店，再左右滑');
        this.apply(0, false);
        return;
      }

      const prev = this.index;
      if (target === prev && !immediate) return;
      this.index = target;
      this.apply(0, immediate);
      if (window.App.onPageChange) {
        window.App.onPageChange(prev, target, !!fromHistory);
      }
    },

    bind() {
      const self = this;
      const pager = this.pager;

      pager.addEventListener('pointerdown', function (event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (event.target.closest('[data-noswipe]')) return;
        if (event.target.closest('input, textarea')) return;
        self.startX = event.clientX;
        self.startY = event.clientY;
        self.dx = 0;
        self.axis = null;
        self.dragging = true;
        self.pointerId = event.pointerId;
      }, { passive: true });

      pager.addEventListener('pointermove', function (event) {
        if (!self.dragging || event.pointerId !== self.pointerId) return;
        const dx = event.clientX - self.startX;
        const dy = event.clientY - self.startY;

        if (!self.axis) {
          if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
          if (Math.abs(dx) > Math.abs(dy) * 1.15) {
            self.axis = 'x';
            self.track.classList.add('is-dragging');
          } else {
            self.axis = 'y';
            self.dragging = false;
            return;
          }
        }

        if (self.axis !== 'x') return;
        if (event.cancelable) event.preventDefault();

        let offset = dx;
        if ((self.index === 0 && dx > 0) || (self.index === self.max && dx < 0)) {
          offset = dx * 0.3;
        }
        self.dx = offset;
        self.apply(offset, false);
      }, { passive: false });

      function finish(event) {
        if (!self.dragging && self.axis !== 'x') return;
        if (event && self.pointerId !== null && event.pointerId !== self.pointerId) return;
        self.dragging = false;
        self.axis = null;
        self.pointerId = null;

        const width = self.paneWidth();
        const dx = self.dx;
        self.dx = 0;

        const passed = Math.abs(dx) > Math.min(width * 0.22, 90);
        const navigate = (target) => {
          if (window.App && window.App.navigateTo) window.App.navigateTo(target);
          else self.go(target);
        };
        if (passed && dx < 0) {
          navigate(self.index + 1);
        } else if (passed && dx > 0) {
          if (self.index === self.max) {
            if (window.App && window.App.goHome) window.App.goHome(false);
            else self.go(0);
          } else {
            navigate(self.index - 1);
          }
        } else {
          self.apply(0, false);
        }
      }

      pager.addEventListener('pointerup', finish);
      pager.addEventListener('pointercancel', finish);
      pager.addEventListener('pointerleave', function (event) {
        if (event.pointerType === 'mouse') finish(event);
      });

      window.addEventListener('resize', function () {
        self.apply(0, true);
      });
    }
  };

  window.Pager = Pager;
})();
