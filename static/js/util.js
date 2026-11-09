/* 通用工具：DOM、格式化、弹层、提示、震动 */
(function () {
  'use strict';

  window.App = window.App || {};
  App.boot = window.APP_CONFIG || {};
  App.state = {
    page: 0,
    items: [],
    location: null,
    manualLocated: false,
    weekend: false,
    weekendManual: false,
    current: null,
    route: null,
    mode: 'walking',
    keyword: '',
    loading: false,
    sourceInfo: null,
    checkinOpen: false,
    buddyOpen: false,
    radarOpen: false,
    locOpen: false,
    user: null,
    fetchedRadius: 3000,
    // 游标分页：radius=当前半径档，offset=服务端已取条数，loading=请求中，noMore=没有更远的了
    pagination: { radius: 3000, offset: 0, loading: false, noMore: false }
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const CUISINE_EMOJI = {
    火锅: '🍲', 日料: '🍣', 烧烤: '🍢', 甜品: '🍰', 咖啡: '☕',
    奶茶: '🧋', 小吃: '🍜', 川菜: '🌶️', 西餐: '🥩', 中餐: '🍚'
  };
  const CUISINE_FALLBACK = {
    火锅: 'hotpot.jpg', 日料: 'sushi.jpg', 烧烤: 'bbq.jpg', 甜品: 'dessert.jpg',
    咖啡: 'coffee.jpg', 奶茶: 'milktea.jpg', 小吃: 'hutong.jpg',
    川菜: 'hotpot.jpg', 西餐: 'hotpot-store.jpg', 中餐: 'hotpot-store.jpg'
  };

  function imgUrl(path, cuisine) {
    if (!path) {
      const file = CUISINE_FALLBACK[cuisine] || 'hotpot-store.jpg';
      return '/static/img/' + file;
    }
    if (String(path).indexOf('//') === 0) return 'https:' + path;
    if (/^https?:\/\//i.test(path)) return path;
    if (path.indexOf('/static/') === 0) return path;
    return '/static/img/' + path;
  }

  /** 列表/缩略图使用 480w 版本，减少移动端解码与传输开销 */
  function thumbUrl(path, cuisine) {
    const full = imgUrl(path, cuisine);
    if (full.indexOf('/static/img/') !== 0 || full.indexOf('/thumb/') >= 0) return full;
    return full.replace('/static/img/', '/static/img/thumb/');
  }

  /** 已解析的本地图片 → 对应 WebP 地址；外部图片或已是缩略图时返回空 */
  function webpFrom(full) {
    if (!full || full.indexOf('/static/img/') !== 0 || full.indexOf('/thumb/') >= 0) return '';
    const base = full.slice('/static/img/'.length).replace(/\.jpe?g$/i, '.webp');
    return '/static/img/' + base;
  }

  /** WebP 两档 srcset；没有对应文件时返回空，调用方回退 JPEG */
  function webpSet(full) {
    if (!full || full.indexOf('/static/img/') !== 0 || full.indexOf('/thumb/') >= 0) return '';
    const base = full.slice('/static/img/'.length).replace(/\.jpe?g$/i, '.webp');
    // 用密度描述符而不是 480w/1080w：部分素材原图本身不足 480px，
    // 写死宽度描述会让浏览器误判清晰度
    return '/static/img/thumb/' + base + ' 1x, /static/img/' + base + ' 2x';
  }

  /** 生成 <source type="image/webp">，配合 <picture> 使用 */
  function webpSource(full, sizes) {
    const set = webpSet(full);
    if (!set) return '';
    return '<source type="image/webp" srcset="' + escapeHtml(set) + '"' +
      (sizes ? ' sizes="' + escapeHtml(sizes) + '"' : '') + '>';
  }

  /** 本地图片返回 srcset（480w / 1080w）；外部 POI 图片不拼接 */
  function srcset(path) {
    if (!path || path.indexOf('/static/img/') !== 0 || path.indexOf('/thumb/') >= 0) return '';
    return '/static/img/thumb/' + path.slice('/static/img/'.length) + ' 1x, ' + path + ' 2x';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(value) {
    if (value == null || value === '' || value === 0) return '人均待补充';
    return '人均 ¥' + value;
  }

  function ratingText(value) {
    return value ? Number(value).toFixed(1) : '暂无';
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(ctx, args), wait);
    };
  }

  function haptic(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern || 18);
    } catch (e) { /* 不支持时静默降级 */ }
  }

  let toastTimer = null;
  function toast(message, ms) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), ms || 2000);
  }

  function loading(show, text) {
    const el = $('#loading');
    if (!el) return;
    if (text) $('#loadingText').textContent = text;
    el.hidden = !show;
  }

  /* ---------------- 半弹层 ---------------- */
  let sheetCloser = null;

  function openSheet(options) {
    const root = $('#sheetRoot');
    if (!root) return { close: function () {} };
    const opts = options || {};
    const previousFocus = document.activeElement;
    closeSheet(true);
    root.innerHTML = '';

    const mask = document.createElement('div');
    mask.className = 'sheet-mask';

    const sheet = document.createElement('div');
    sheet.className = 'sheet' + (opts.className ? ' ' + opts.className : '');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.tabIndex = -1;

    const handle = document.createElement('div');
    handle.className = 'sheet-handle';
    sheet.appendChild(handle);

    if (opts.title) {
      const title = document.createElement('h3');
      title.className = 'sheet-title';
      title.textContent = opts.title;
      sheet.appendChild(title);
    }
    if (opts.subtitle) {
      const sub = document.createElement('p');
      sub.className = 'sheet-sub';
      sub.textContent = opts.subtitle;
      sheet.appendChild(sub);
    }

    const body = document.createElement('div');
    body.className = 'sheet-body';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    sheet.appendChild(body);

    if (opts.actions && opts.actions.length) {
      const actions = document.createElement('div');
      actions.className = 'sheet-actions';
      opts.actions.forEach((action) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = action.variant === 'ghost' ? 'btn-outline' : 'btn-primary';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          if (action.onClick) action.onClick(sheet);
          if (action.close !== false) closeSheet();
        });
        actions.appendChild(btn);
      });
      sheet.appendChild(actions);
    }

    root.appendChild(mask);
    root.appendChild(sheet);
    requestAnimationFrame(() => root.classList.add('is-open'));
    try { sheet.focus({ preventScroll: true }); } catch (e) { /* 老浏览器忽略 */ }

    mask.addEventListener('click', () => closeSheet());

    const focusables = () => Array.from(sheet.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null);

    const onKey = (event) => {
      if (event.key === 'Escape') {
        closeSheet();
        return;
      }
      if (event.key !== 'Tab') return;
      // 焦点陷阱：Tab 只在弹层内循环，不跑到遮罩后的页面
      const list = focusables();
      if (!list.length) {
        event.preventDefault();
        sheet.focus({ preventScroll: true });
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === sheet)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKey);

    sheetCloser = function () {
      document.removeEventListener('keydown', onKey);
      if (opts.onClose) opts.onClose();
      sheetCloser = null;
      if (previousFocus && previousFocus.focus && document.contains(previousFocus)) {
        try { previousFocus.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
      }
    };

    return { close: closeSheet, sheet: sheet, body: body };
  }

  function closeSheet(immediate) {
    const root = $('#sheetRoot');
    if (!root) return;
    root.classList.remove('is-open');
    const closer = sheetCloser;
    sheetCloser = null;
    if (closer) closer();
    if (immediate) {
      root.innerHTML = '';
    } else {
      setTimeout(() => { if (!root.classList.contains('is-open')) root.innerHTML = ''; }, 320);
    }
  }

  function dayParts(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return { label: dateStr, weekday: '' };
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return { label: (d.getMonth() + 1) + '月' + d.getDate() + '日', weekday: week };
  }

  function todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /** 解析「11:00」「次日 02:00」两种营业时间写法 */
  function parseClock(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const nextDay = raw.indexOf('次日') >= 0;
    const parts = raw.replace('次日', '').trim().split(':');
    if (parts.length !== 2) return null;
    const hour = Number(parts[0]);
    const minute = Number(parts[1]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
    return { minutes: hour * 60 + minute, nextDay: nextDay };
  }

  /**
   * 营业状态：支持跨夜（22:00-次日 02:00）。
   * 缺少营业时间时返回 known=false，调用方应视为「未知」而不是「打烊」。
   */
  function openState(item, now) {
    if (!item) return { known: false, open: true, label: '' };
    const start = parseClock(item.openTime);
    const close = parseClock(item.closeTime);
    if (!start || !close) return { known: false, open: true, label: '' };

    let closeMinutes = close.minutes + (close.nextDay ? 1440 : 0);
    if (closeMinutes <= start.minutes) closeMinutes += 1440; // 22:00-02:00 未写次日

    const date = now || new Date();
    const minutes = date.getHours() * 60 + date.getMinutes();
    const open =
      (minutes >= start.minutes && minutes <= closeMinutes) ||
      (minutes + 1440 >= start.minutes && minutes + 1440 <= closeMinutes);

    return { known: true, open: open, label: open ? '营业中' : '已打烊' };
  }

  App.util = {
    $, $$, imgUrl, thumbUrl, srcset, webpFrom, webpSet, webpSource,
    escapeHtml, money, ratingText, debounce, haptic, toast, loading,
    openSheet, closeSheet, dayParts, todayStr, clamp, openState, CUISINE_EMOJI, CUISINE_FALLBACK
  };
})();
