/* 本地存储：打卡、偏好、备份。无账号体系，全部数据只在本机。 */
(function () {
  'use strict';

  // 存储键保持旧名，避免改名后已有打卡记录丢失
  const KEY = 'weekend_eat_v1';
  // 匿名设备号单独存放：清空打卡不影响服务端身份绑定
  const DEVICE_KEY = 'today_eat_device_v1';
  const MAX_RECORDS = 800;

  function emptyData() {
    return {
      version: 1,
      checkins: [],
      prefs: {
        weekendManualDate: null,
        weekendManualValue: null,
        weekendSubmode: 'solo',
        lastExportAt: null,
        lastBackupPromptDate: null,
        location: null
      }
    };
  }

  const Store = {
    data: emptyData(),
    available: true,
    memoryOnly: false,

    load() {
      try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) { this.data = emptyData(); return this.data; }
        const parsed = JSON.parse(raw);
        const base = emptyData();
        this.data = {
          version: parsed.version || 1,
          checkins: Array.isArray(parsed.checkins) ? parsed.checkins : [],
          prefs: Object.assign(base.prefs, parsed.prefs || {})
        };
      } catch (e) {
        this.available = false;
        this.data = emptyData();
      }
      return this.data;
    },

    save() {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(this.data));
        this.memoryOnly = false;
      } catch (e) {
        this.memoryOnly = true;
        App.util.toast('浏览器存储不可用，本次记录可能无法保留');
      }
    },

    /* ---------------- 匿名设备身份 ---------------- */
    deviceId() {
      let id = null;
      try {
        id = window.localStorage.getItem(DEVICE_KEY);
      } catch (e) {
        id = null;
      }
      if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return id;

      let raw = '';
      try {
        if (window.crypto && window.crypto.randomUUID) {
          raw = window.crypto.randomUUID().replace(/-/g, '');
        }
      } catch (e) { /* 老浏览器兜底 */ }
      if (!raw) {
        raw = Math.random().toString(36).slice(2) + Date.now().toString(36);
      }
      id = ('d' + raw).slice(0, 40);
      try {
        window.localStorage.setItem(DEVICE_KEY, id);
      } catch (e) { /* 隐私模式下仅本次会话有效 */ }
      return id;
    },

    /* ---------------- 打卡 ---------------- */
    hasCheckedToday(id) {
      const today = App.util.todayStr();
      return this.data.checkins.some((item) => item.id === id && item.date === today);
    },

    hasChecked(id) {
      return this.data.checkins.some((item) => item.id === id);
    },

    addCheckin(item) {
      const today = App.util.todayStr();
      if (this.hasCheckedToday(item.id)) {
        return { added: false, reason: 'today' };
      }
      const record = {
        id: item.id,
        name: item.name,
        cuisine: item.cuisine || '中餐',
        subCuisine: item.subCuisine || '',
        avgPrice: item.avgPrice || null,
        rating: item.rating || null,
        cover: item.cover || (item.gallery && item.gallery[0]) || '',
        gallery: (item.gallery || []).slice(0, 3),
        lat: item.lat,
        lng: item.lng,
        address: item.address || '',
        date: today,
        createdAt: Date.now()
      };
      this.data.checkins.unshift(record);
      if (this.data.checkins.length > MAX_RECORDS) {
        this.data.checkins = this.data.checkins.slice(0, MAX_RECORDS);
      }
      this.data.prefs.lastChangeAt = Date.now();
      this.save();
      return { added: true, record: record };
    },

    checkinsSorted() {
      return this.data.checkins.slice().sort((a, b) => {
        if (a.date === b.date) return (b.createdAt || 0) - (a.createdAt || 0);
        return a.date < b.date ? 1 : -1;
      });
    },

    stats() {
      const list = this.data.checkins;
      const now = new Date();
      const prefix = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const monthCount = list.filter((item) => (item.date || '').indexOf(prefix) === 0).length;
      const counter = {};
      list.forEach((item) => {
        const key = item.cuisine || '其他';
        counter[key] = (counter[key] || 0) + 1;
      });
      let topCuisine = '';
      let topCount = 0;
      Object.keys(counter).forEach((key) => {
        if (counter[key] > topCount) { topCuisine = key; topCount = counter[key]; }
      });
      return {
        total: list.length,
        monthCount: monthCount,
        topCuisine: topCuisine,
        topCount: topCount,
        cuisines: counter
      };
    },

    /* ---------------- 偏好 ---------------- */
    prefs() {
      return this.data.prefs;
    },

    setWeekend(value) {
      this.data.prefs.weekendManualDate = App.util.todayStr();
      this.data.prefs.weekendManualValue = !!value;
      this.save();
    },

    resolveWeekendSubmode() {
      return this.data.prefs.weekendSubmode === 'group' ? 'group' : 'solo';
    },

    setWeekendSubmode(mode) {
      this.data.prefs.weekendSubmode = mode === 'group' ? 'group' : 'solo';
      this.save();
    },

    resolveWeekend(autoWeekend) {
      const prefs = this.data.prefs;
      if (prefs.weekendManualDate === App.util.todayStr() && typeof prefs.weekendManualValue === 'boolean') {
        return { value: prefs.weekendManualValue, manual: true };
      }
      return { value: !!autoWeekend, manual: false };
    },

    setLocation(location) {
      this.data.prefs.location = location;
      this.save();
    },

    getLocation() {
      return this.data.prefs.location || null;
    },

    /* ---------------- 备份 ---------------- */
    exportJSON() {
      const payload = {
        app: '今天吃啥',
        version: 1,
        exportedAt: new Date().toISOString(),
        note: '仅包含本机打卡记录与偏好，无账号、无位置轨迹',
        checkins: this.data.checkins,
        prefs: {
          weekendManualDate: this.data.prefs.weekendManualDate,
          weekendManualValue: this.data.prefs.weekendManualValue
        }
      };
      const text = JSON.stringify(payload, null, 2);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = App.util.todayStr().replace(/-/g, '');
      a.href = url;
      a.download = '今天吃啥-打卡备份-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      this.data.prefs.lastExportAt = Date.now();
      this.save();
      return { count: this.data.checkins.length };
    },

    importJSON(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return { ok: false, message: '文件不是有效的 JSON' };
      }
      const incoming = Array.isArray(parsed) ? parsed : (parsed.checkins || []);
      if (!Array.isArray(incoming) || !incoming.length) {
        return { ok: false, message: '文件里没有找到打卡记录' };
      }
      const key = (item) => item.id + '|' + item.date;
      const exist = new Set(this.data.checkins.map(key));
      let added = 0, skipped = 0;
      incoming.forEach((raw) => {
        if (!raw || !raw.id || !raw.name || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')) { skipped++; return; }
        if (exist.has(key(raw))) { skipped++; return; }
        exist.add(key(raw));
        this.data.checkins.push({
          id: String(raw.id),
          name: String(raw.name).slice(0, 40),
          cuisine: raw.cuisine || '其他',
          subCuisine: raw.subCuisine || '',
          avgPrice: raw.avgPrice || null,
          rating: raw.rating || null,
          cover: raw.cover || '',
          gallery: Array.isArray(raw.gallery) ? raw.gallery.slice(0, 3) : [],
          lat: raw.lat, lng: raw.lng,
          address: raw.address || '',
          date: raw.date,
          createdAt: raw.createdAt || Date.now()
        });
        added++;
      });
      this.data.checkins = this.checkinsSorted();
      if (added) this.data.prefs.lastChangeAt = Date.now();
      this.save();
      return { ok: true, added: added, skipped: skipped };
    }
  };

  window.Store = Store;
})();
