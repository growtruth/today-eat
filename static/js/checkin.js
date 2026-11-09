/* P5 我的打卡：统计、按日期分组、导出 / 导入、清缓存提醒 */
(function () {
  'use strict';

  const Checkin = {
    init() {
      const self = this;
      const close = document.getElementById('checkinClose');
      if (close) close.addEventListener('click', () => self.close());
      const exportBtn = document.getElementById('exportBtn');
      if (exportBtn) exportBtn.addEventListener('click', () => self.exportData());
      const importBtn = document.getElementById('importBtn');
      const file = document.getElementById('importFile');
      if (importBtn && file) {
        importBtn.addEventListener('click', () => file.click());
        file.addEventListener('change', () => {
          if (file.files && file.files[0]) self.importFile(file.files[0]);
          file.value = '';
        });
      }
      const source = document.getElementById('checkinSourceBtn');
      if (source) source.addEventListener('click', () => App.openSourceSheet());

      const login = document.getElementById('cloudLoginBtn');
      if (login) login.addEventListener('click', () => self.cloudLogin());
    },

    cloudLogin() {
      if (!Cloud.enabled) {
        App.util.toast('云服务未配置');
        return;
      }
      Cloud.signedIn().then((ok) => {
        if (ok) {
          Cloud.signOut().then(() => {
            this.refreshCloudState();
            App.util.toast('已退出云端同步');
          });
        } else {
          Cloud.signInWithWorkBuddy().then((res) => {
            if (res.error) App.util.toast('登录失败：' + (res.error.message || '请重试'));
          });
        }
      });
    },

    refreshCloudState() {
      const row = document.getElementById('cloudRow');
      const status = document.getElementById('cloudStatus');
      const dot = document.getElementById('cloudDot');
      const login = document.getElementById('cloudLoginBtn');
      if (!row || !Cloud.enabled) {
        if (row) row.hidden = true;
        return;
      }
      row.hidden = false;
      Cloud.signedIn().then((ok) => {
        if (status) status.textContent = ok ? '已登录 · 打卡自动同步云端' : '打卡暂存本机';
        if (dot) dot.classList.toggle('is-on', ok);
        if (login) {
          login.textContent = ok ? '退出登录' : '登录同步';
        }
      });
    },

    open() {
      this.render();
      this.refreshCloudState();
      const layer = document.getElementById('checkinLayer');
      layer.classList.add('is-open');
      layer.setAttribute('aria-hidden', 'false');
      App.state.checkinOpen = true;
      document.body.classList.add('is-checkin');
      App.updateChrome();
      this.maybeRemind();
    },

    close() {
      const layer = document.getElementById('checkinLayer');
      layer.classList.remove('is-open');
      layer.setAttribute('aria-hidden', 'true');
      App.state.checkinOpen = false;
      document.body.classList.remove('is-checkin');
      App.updateChrome();
    },

    render() {
      const util = App.util;
      const stats = Store.stats();
      document.getElementById('statTotal').textContent = stats.total;
      document.getElementById('statSub').textContent = stats.total
        ? '本月新增 ' + stats.monthCount + ' 家 · ' + (stats.topCuisine ? stats.topCuisine + '吃了 ' + stats.topCount + ' 次' : '还没有高频品类')
        : '本月新增 0 家 · 还没有高频品类';

      const box = document.getElementById('checkinGroups');
      box.innerHTML = '';

      if (!stats.total) {
        box.innerHTML =
          '<div class="checkin-empty">' +
          '<div class="emoji">🍽️</div>' +
          '<h3>还没有打卡记录</h3>' +
          '<p>在商家详情页点「吃过了」，就会记在这里。<br>数据只存在本机，不需要登录。</p>' +
          '<button class="btn-outline" id="goPickBtn" type="button">去挑一家</button>' +
          '</div>';
        const go = document.getElementById('goPickBtn');
        if (go) go.addEventListener('click', () => {
          this.close();
          App.goHome(false);
        });
        return;
      }

      const list = Store.checkinsSorted();
      const groups = {};
      list.forEach((item) => {
        const key = item.date;
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      });

      Object.keys(groups).forEach((date) => {
        const group = groups[date];
        const parts = util.dayParts(date);
        const head = document.createElement('div');
        head.className = 'group-head';
        head.innerHTML = '<span class="group-date">' + parts.label + '<em>' + parts.weekday + '</em></span>' +
          '<span class="group-count">' + group.length + ' 家</span>';
        box.appendChild(head);

        const grid = document.createElement('div');
        grid.className = 'checkin-grid';
        group.forEach((record) => {
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'checkin-card';
          card.innerHTML =
            '<div class="media"><picture>' +
            util.webpSource(util.imgUrl(record.cover || (record.gallery || [])[0], record.cuisine), '45vw') +
            '<img loading="lazy" src="' +
            util.escapeHtml(util.thumbUrl(record.cover || (record.gallery || [])[0], record.cuisine)) +
            '" alt="' + util.escapeHtml(record.name) + '"></picture></div>' +
            '<div class="body"><div class="name">' + util.escapeHtml(record.name) + '</div>' +
            '<div class="meta">' + util.escapeHtml(record.cuisine) +
            (record.avgPrice ? ' · ¥' + record.avgPrice : '') + '</div></div>';
          card.addEventListener('click', () => this.openRecord(record));
          grid.appendChild(card);
        });
        box.appendChild(grid);
      });
    },

    openRecord(record) {
      const fromFeed = (Feed.items || []).filter((item) => item.id === record.id)[0];
      const item = fromFeed || {
        id: record.id,
        name: record.name,
        cuisine: record.cuisine,
        subCuisine: record.subCuisine,
        avgPrice: record.avgPrice,
        rating: record.rating,
        cover: record.cover,
        gallery: record.gallery,
        lat: record.lat,
        lng: record.lng,
        address: record.address,
        distance: null,
        tags: []
      };
      this.close();
      setTimeout(() => Detail.open(item), 280);
    },

    exportData() {
      const result = Store.exportJSON();
      App.util.toast('已导出 ' + result.count + ' 条打卡记录');
    },

    importFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = Store.importJSON(String(reader.result || ''));
        if (!result.ok) {
          App.util.toast(result.message || '导入失败');
          return;
        }
        this.render();
        App.util.toast('导入完成 · 新增 ' + result.added + ' 条，跳过 ' + result.skipped + ' 条');
      };
      reader.onerror = () => App.util.toast('文件读取失败');
      reader.readAsText(file, 'utf-8');
    },

    maybeRemind() {
      const stats = Store.stats();
      if (!stats.total) return;
      const prefs = Store.prefs();
      const today = App.util.todayStr();
      if (prefs.lastBackupPromptDate === today) return;
      const lastExport = prefs.lastExportAt || 0;
      const days = (Date.now() - lastExport) / 86400000;
      if (lastExport && days < 7) return;
      prefs.lastBackupPromptDate = today;
      Store.save();
      setTimeout(() => {
        App.util.toast('打卡已 ' + (lastExport ? Math.floor(days) + ' 天' : '有一阵') + '没备份，建议导出 JSON', 2600);
      }, 600);
    }
  };

  window.Checkin = Checkin;
})();
