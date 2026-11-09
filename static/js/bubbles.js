/* 评价泡泡：从下往上飘、由小变大，大小随赞数变化；离开页面即暂停 */
(function () {
  'use strict';

  const COLORS = ['bubble--orange', 'bubble--cream', 'bubble--mint', 'bubble--deep'];

  const Bubbles = {
    stage: null,
    reviews: [],
    nodes: [],
    raf: null,
    running: false,
    lastTs: 0,
    reduceMotion: false,

    init(stage) {
      this.stage = stage;
      this.reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },

    set(reviews) {
      this.reviews = (reviews || []).slice(0, 6);
      this.clear();
    },

    clear() {
      this.pause();
      if (this.stage) {
        Array.from(this.stage.querySelectorAll('.bubble')).forEach((node) => node.remove());
      }
      this.nodes = [];
    },

    build() {
      if (!this.stage) return;
      const width = this.stage.clientWidth || 340;
      const height = this.stage.clientHeight || 300;

      this.reviews.forEach((review, index) => {
        const likes = review.likes || 10;
        const size = Math.max(54, Math.min(102, 52 + Math.sqrt(likes) * 3.1));
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'bubble ' + COLORS[index % COLORS.length];
        node.style.width = size + 'px';
        node.style.height = size + 'px';

        const text = document.createElement('span');
        text.className = 'bubble-text';
        text.textContent = review.text;
        node.appendChild(text);

        const like = document.createElement('span');
        like.className = 'bubble-like';
        like.textContent = '🔥 ' + likes + ' 赞';
        node.appendChild(like);

        const laneCount = Math.max(2, Math.floor(width / 118));
        const laneWidth = width / laneCount;
        const lane = index % laneCount;
        const state = {
          el: node,
          size: size,
          lane: lane,
          laneWidth: laneWidth,
          laneCount: laneCount,
          x: Math.min(width - size - 4, Math.max(4, lane * laneWidth + (laneWidth - size) / 2)),
          y: height - size - Math.floor(index / laneCount) * (height / 2.2) - Math.random() * 16,
          speed: 9 + (lane % 3) * 1.1 + Math.random() * 1.4,
          age: 1.6,
          phase: Math.random() * Math.PI * 2,
          sway: 2 + Math.random() * 3
        };
        node.style.transform = 'translate3d(' + state.x + 'px,' + state.y + 'px,0) scale(0.92)';
        node.addEventListener('click', () => showReview(review));

        this.stage.appendChild(node);
        this.nodes.push(state);
      });
    },

    start() {
      if (!this.stage || !this.reviews.length) return;
      if (!this.nodes.length) this.build();
      if (this.running || this.reduceMotion) return;
      this.running = true;
      this.lastTs = 0;
      const step = (ts) => {
        if (!this.running) return;
        if (!this.lastTs) this.lastTs = ts;
        const dt = Math.min(48, ts - this.lastTs) / 1000;
        this.lastTs = ts;
        this.update(dt);
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    },

    update(dt) {
      const height = this.stage.clientHeight || 300;
      const width = this.stage.clientWidth || 340;
      this.nodes.forEach((b) => {
        b.y -= b.speed * dt;
        b.age += dt;
        const sway = Math.sin((b.y + b.phase * 40) / 70) * b.sway * dt * 4;
        let x = b.x + sway;
        if (x < 3) x = 3;
        if (x > width - b.size - 3) x = width - b.size - 3;

        if (b.y < -b.size * 1.15) {
          b.y = height + b.size * 0.55;
          b.x = Math.min(width - b.size - 4, Math.max(4, b.lane * b.laneWidth + (b.laneWidth - b.size) / 2));
          b.age = 0;
        }
        const scale = 0.62 + 0.38 * Math.min(1, b.age / 2.2);
        let opacity = 1;
        if (b.age < 0.7) opacity = b.age / 0.7;
        if (b.y < 46) opacity = Math.max(0, b.y / 46);
        b.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + b.y.toFixed(1) + 'px,0) scale(' + scale.toFixed(3) + ')';
        b.el.style.opacity = opacity.toFixed(2);
      });
    },

    pause() {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  };

  function showReview(review) {
    const util = App.util;
    const body = document.createElement('div');
    body.innerHTML =
      '<div style="display:flex;align-items:center;gap:9px;margin-bottom:14px">' +
      '<span style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
      'background:' + (review.avatarColor || '#FFE3C7') + ';font-size:13px;font-weight:600;color:#7A5B44">' +
      util.escapeHtml((review.user || '匿名').slice(0, 1)) + '</span>' +
      '<div><div style="font-size:13px;font-weight:600">' + util.escapeHtml(review.user) + '</div>' +
      '<div style="font-size:10px;color:#B4A79E">' + util.escapeHtml(review.platform || '地图公开摘要') +
      ' · ' + util.escapeHtml(review.time || '') + '</div></div></div>' +
      '<p style="font-size:14px;line-height:1.8;color:#4A3F3A">' + util.escapeHtml(review.text) + '</p>' +
      '<p style="margin-top:12px;font-size:11px;color:#B4A79E">🔥 ' + (review.likes || 0) + ' 人觉得有用 · 内容来自地图公开评价摘要</p>';

    App.util.openSheet({
      title: '这条评价说了什么',
      body: body,
      actions: [{ label: '知道了', variant: 'ghost' }]
    });
  }

  window.Bubbles = Bubbles;
})();
