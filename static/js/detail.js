/* P2 商家详情：门店实拍、标签、一键打卡、泡泡评价、笔记流、出行方式 */
(function () {
  'use strict';

  const Detail = {
    item: null,
    data: null,
    galleryIndex: 1,
    galleryTotal: 1,
    seq: 0,
    controller: null,

    init() {
      const self = this;
      const decide = document.getElementById('decideBtn');
      if (decide) decide.addEventListener('click', () => self.openTravelSheet());

      const deals = document.getElementById('dealsBtn');
      if (deals) deals.addEventListener('click', () => {
        if (!self.item) return;
        Deals.open(self.item);
      });

      const buddy = document.getElementById('detailBuddyBtn');
      if (buddy) buddy.addEventListener('click', () => {
        if (!self.item) return;
        App.state.current = self.item;
        Buddy.askForStore();
      });

      const checkin = document.getElementById('checkinBtn');
      if (checkin) checkin.addEventListener('click', () => self.doCheckin());

      const address = document.getElementById('addressBtn');
      if (address) address.addEventListener('click', () => {
        if (!self.item) return;
        App.util.openSheet({
          title: '门店地址',
          subtitle: self.item.name,
          body: '<p style="font-size:13px;line-height:1.8;color:#4A3F3A;text-align:center">' +
            App.util.escapeHtml(self.item.address || '地址待补充') + '</p>',
          actions: [{ label: '复制地址', onClick: () => self.copyAddress() }, { label: '知道了', variant: 'ghost' }]
        });
      });

      const gallery = document.getElementById('detailGallery');
      if (gallery) {
        const track = document.getElementById('galleryTrack');
        track.addEventListener('scroll', () => {
          const width = track.clientWidth || 1;
          const index = Math.round(track.scrollLeft / width) + 1;
          if (index !== self.galleryIndex) {
            self.galleryIndex = index;
            self.updateGalleryCount();
          }
        }, { passive: true });
      }

      const refresh = document.getElementById('detailRefresh');
      if (refresh) refresh.addEventListener('click', () => App.goHome(true));
      const draw = document.getElementById('detailDraw');
      if (draw) draw.addEventListener('click', () => Draw.trigger());

      Bubbles.init(document.getElementById('bubbleStage'));
    },

    async open(item) {
      if (!item) return;
      const seq = ++this.seq;
      if (this.controller) this.controller.abort();
      this.controller = new AbortController();

      this.item = item;
      this.data = null;
      App.state.current = item;
      this.render(item);
      App.navigateTo(1);
      await this.loadDetail(item, seq, this.controller.signal);
    },

    render(item) {
      const util = App.util;
      document.getElementById('detailName').textContent = item.name;

      const openBadge = document.getElementById('detailOpen');
      const status = App.util.openState(item);
      if (status.known) {
        openBadge.hidden = false;
        openBadge.textContent = status.label;
        openBadge.classList.toggle('is-closed', !status.open);
      } else {
        openBadge.hidden = true;
      }

      // 标签
      const tagRow = document.getElementById('detailTags');
      tagRow.innerHTML = '';
      const tags = (item.tags && item.tags.length) ? item.tags.slice(0, 3) : [];
      if (!tags.length) tags.push(item.cuisine || '中餐');
      tags.forEach((tag, index) => {
        const span = document.createElement('span');
        span.className = 'tag' + (index === 2 ? ' tag--mint' : '');
        span.textContent = tag;
        tagRow.appendChild(span);
      });

      document.getElementById('detailRating').textContent = util.ratingText(item.rating);
      document.getElementById('detailPrice').textContent = util.money(item.avgPrice);
      document.getElementById('detailDistance').textContent = item.distanceLabel ||
        (item.distance ? (item.distance / 1000).toFixed(1) + 'km' : '距离待补充');
      document.getElementById('detailCuisine').textContent = item.subCuisine || item.cuisine || '';

      const shortAddress = (item.address || '门店地址').split('（')[0].slice(0, 10);
      document.getElementById('detailAddressShort').textContent = shortAddress;

      const btn = document.getElementById('checkinBtn');
      const done = Store.hasCheckedToday(item.id);
      btn.classList.toggle('is-done', done);
      btn.querySelector('span').textContent = done ? '今天已打卡' : '吃过了';

      this.renderGallery(item);
      this.renderReviews(item.reviews || [], item.notes || []);
    },

    renderGallery(item) {
      const track = document.getElementById('galleryTrack');
      const util = App.util;
      let images = (item.gallery && item.gallery.length) ? item.gallery.slice(0, 6) : [];
      if (!images.length) images = [item.cover || ''];
      images = images.map((img) => util.imgUrl(img, item.cuisine));

      track.innerHTML = '';
      images.forEach((src, index) => {
        const slide = document.createElement('div');
        slide.className = 'gallery-slide';
        const img = document.createElement('img');
        img.src = src;
        img.alt = item.name;
        img.loading = index === 0 ? 'eager' : 'lazy';
        img.decoding = 'async';
        if (index === 0) img.fetchPriority = 'high';
        const set = util.srcset(src);
        if (set) {
          img.srcset = set;
          img.sizes = '100vw';
        }
        img.addEventListener('error', function () {
          this.src = util.imgUrl('', item.cuisine);
          this.onerror = null;
        });
        const source = util.webpSource(src, '100vw');
        if (source) {
          const picture = document.createElement('picture');
          picture.innerHTML = source;
          picture.appendChild(img);
          slide.appendChild(picture);
        } else {
          slide.appendChild(img);
        }
        track.appendChild(slide);
      });
      this.galleryTotal = images.length;
      this.galleryIndex = 1;
      this.updateGalleryCount();
      track.scrollLeft = 0;
    },

    updateGalleryCount() {
      document.getElementById('galleryCount').textContent = this.galleryIndex + '/' + this.galleryTotal;
    },

    async loadDetail(item, seq, signal) {
      try {
        const data = await API.detail(item.id, { signal: signal });
        if (seq !== this.seq || App.state.current !== item) return;

        const merged = Object.assign({}, item, data.item || {});
        merged.distance = item.distance;
        merged.distanceLabel = item.distanceLabel;
        this.data = merged;

        // 只刷新异步补齐的部分，避免整页重绘导致图片重载、画廊回到第一张
        this.syncExtras(merged);
        this.renderReviews(merged.reviews || [], merged.notes || []);
        if (Pager.index === 1) Bubbles.start();
      } catch (e) {
        if (e.code === 'aborted') return;
        // 详情拉不到时用列表数据兜底，不阻断页面
        this.renderReviews(item.reviews || [], item.notes || []);
        Bubbles.start();
      }
    },

    /** 列表数据已渲染过，这里只补齐详情接口可能带来的增量字段 */
    syncExtras(item) {
      const ratingEl = document.getElementById('detailRating');
      if (ratingEl) ratingEl.textContent = App.util.ratingText(item.rating);
      const priceEl = document.getElementById('detailPrice');
      if (priceEl) priceEl.textContent = App.util.money(item.avgPrice);

      const hadGallery = !!(this.item && this.item.gallery && this.item.gallery.length);
      if (!hadGallery && item.gallery && item.gallery.length) {
        this.renderGallery(item);
      }
    },

    renderReviews(reviews, notes) {
      const util = App.util;
      const empty = document.getElementById('bubbleEmpty');
      const link = document.getElementById('reviewLink');
      const item = this.item || {};

      Bubbles.set(reviews || []);
      empty.hidden = !!(reviews && reviews.length);

      if (link) {
        if (item.source === 'demo' || String(item.id).indexOf('demo-') === 0) {
          link.href = '#';
          link.textContent = '演示数据 · 评价为项目自建语料';
          link.removeAttribute('target');
        } else if (item.source === 'amap') {
          link.href = 'https://www.amap.com/place/' + encodeURIComponent(item.id);
          link.textContent = '去高德看完整评价';
          link.target = '_blank';
        } else if (item.source === 'baidu') {
          link.href = 'https://map.baidu.com/?qt=info&uid=' + encodeURIComponent(item.id);
          link.textContent = '去百度地图看完整评价';
          link.target = '_blank';
        } else {
          link.href = '#';
          link.textContent = '暂无可跳转的评价来源';
          link.removeAttribute('target');
        }
      }

      const box = document.getElementById('detailNotes');
      box.innerHTML = '';
      const list = (notes && notes.length) ? notes : [];
      if (!list.length) {
        box.innerHTML = '<p style="font-size:11px;color:#B4A79E;padding:8px 0 2px">' +
          '暂无可展示的笔记，评价仅使用地图 POI 公开摘要。</p>';
        return;
      }
      list.forEach((note) => {
        const row = document.createElement('div');
        row.className = 'note';
        row.innerHTML =
          '<span class="note-avatar" style="background:' + util.escapeHtml(note.avatarColor || '#FFE3C7') + '">' +
          util.escapeHtml((note.user || '匿').slice(0, 1)) + '</span>' +
          '<div class="note-body">' +
          '<div class="note-user">' + util.escapeHtml(note.user || '匿名') + '</div>' +
          '<p class="note-text">' + util.escapeHtml(note.text) + '</p>' +
          '<div class="note-meta"><span>' + util.escapeHtml(note.platform || '地图公开摘要') + '</span>' +
          '<span>' + util.escapeHtml(note.time || '') + '</span><span>🔥 ' + (note.likes || 0) + '</span></div>' +
          '</div>';
        box.appendChild(row);
      });
    },

    doCheckin() {
      if (!this.item) return;
      const result = Store.addCheckin(this.item);
      const btn = document.getElementById('checkinBtn');
      if (result.added) {
        btn.classList.add('is-done');
        btn.querySelector('span').textContent = '今天已打卡';
        App.util.haptic([12, 30, 12]);
        const total = Store.stats().total;
        App.util.toast('已记入我的打卡 · 共 ' + total + ' 家');
        // 登录后打卡同步上云（尽力而为，失败不打断）
        if (Cloud.enabled) {
          Cloud.signedIn().then((ok) => {
            if (!ok) return;
            Cloud.addCheckin({
              store_id: this.item.id,
              store_name: this.item.name,
              cuisine: this.item.cuisine,
              avg_price: this.item.avgPrice,
              day: App.util.todayStr()
            }).then((res) => {
              if (res.error) App.util.toast('云端同步失败，打卡仍在本机', 2200);
            });
          });
        }
      } else {
        App.util.toast('今天已经给这家打过卡啦');
      }
    },

    copyAddress() {
      const text = (this.item && this.item.address) || '';
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => App.util.toast('地址已复制'));
      } else {
        App.util.toast(text);
      }
    },

    openTravelSheet() {
      if (!this.item) return;
      const item = this.item;
      const distance = item.distance || 1000;
      const modes = [
        { key: 'walking', label: '步行', icon: 'i-walk', minutes: Math.max(1, Math.round(distance * 1.16 / 78)) },
        { key: 'cycling', label: '骑行', icon: 'i-bike', minutes: Math.max(1, Math.round(distance * 1.12 / 208)) },
        { key: 'driving', label: '驾车', icon: 'i-car', minutes: Math.max(1, Math.round(distance * 1.26 / 380)) }
      ];
      let selected = App.state.mode || 'walking';

      const body = document.createElement('div');
      const row = document.createElement('div');
      row.className = 'mode-cards';
      modes.forEach((mode) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mode-card' + (mode.key === selected ? ' is-on' : '');
        btn.dataset.mode = mode.key;
        btn.innerHTML = '<svg class="ico"><use href="#' + mode.icon + '"></use></svg>' +
          '<b>' + mode.label + ' · ' + mode.minutes + '分</b>';
        btn.addEventListener('click', () => {
          selected = mode.key;
          Array.from(row.children).forEach((child) => child.classList.toggle('is-on', child.dataset.mode === selected));
        });
        row.appendChild(btn);
      });
      body.appendChild(row);

      const note = document.createElement('p');
      note.style.cssText = 'font-size:10.5px;color:#B4A79E;line-height:1.6;margin-top:10px;text-align:center';
      note.textContent = '距离约 ' + (distance / 1000).toFixed(1) + ' 公里，时长为估算值，进入导航后以实际路线为准。';
      body.appendChild(note);

      App.util.openSheet({
        title: '怎么去这家店？',
        subtitle: item.name,
        body: body,
        actions: [{
          label: '开始导航',
          onClick: () => {
            App.state.mode = selected;
            Nav.open(selected);
          }
        }]
      });
    },

    onEnter() {
      if (this.item && this.data) Bubbles.start();
    },

    onLeave() {
      Bubbles.pause();
    }
  };

  window.Detail = Detail;
})();
