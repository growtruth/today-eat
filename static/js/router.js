/* 页面栈：P1–P4 切换、浏览器返回键、底部导航与首次提示 */
(function () {
  'use strict';

  const App = window.App;
  const util = App.util;

  let pendingRefresh = false;
  let homeScrollTop = 0;

  /* ---------------- 首次使用提示 ---------------- */
  function showHint() {
    const el = document.getElementById('gestureHint');
    if (!el) return;
    const prefs = Store.prefs();
    if (prefs.gestureHintAt) return;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-show'));
    prefs.gestureHintAt = Date.now();
    Store.save();
    setTimeout(hideHint, 6000);
  }

  function hideHint() {
    const el = document.getElementById('gestureHint');
    if (!el || el.hidden) return;
    el.classList.remove('is-show');
    setTimeout(() => { el.hidden = true; }, 260);
  }

  /* ---------------- 页面栈 ---------------- */
  function navigateTo(index) {
    const target = Math.max(0, Math.min(Pager.max, Number(index) || 0));
    if (target === Pager.index) return;
    const state = history.state || {};

    if (target > Pager.index) {
      history.pushState({ eatPage: target }, '');
      Pager.go(target, false, true);
    } else if (typeof state.eatPage === 'number' && state.eatPage === Pager.index) {
      // 后退交给浏览器，由 popstate 完成真实切换，避免历史栈错位
      history.back();
    } else {
      Pager.go(target, false, true);
    }
  }

  function initHistory() {
    history.replaceState({ eatPage: 0 }, '');
    // 多留一条同页记录：首页/浮层状态下按返回键先被它吸收，不会直接退出站点
    history.pushState({ eatPage: 0 }, '');

    window.addEventListener('popstate', function (event) {
      const state = event.state || {};

      // 浮层打开时，返回键优先关闭浮层，并补一条状态避免直接退出站点
      if (App.state.checkinOpen || App.state.buddyOpen || App.state.radarOpen || App.state.locOpen) {
        if (App.state.checkinOpen) Checkin.close();
        if (App.state.buddyOpen) Buddy.close();
        if (App.state.radarOpen) Radar.close();
        if (App.state.locOpen) LocDetail.close();
        history.pushState({ eatPage: Pager.index }, '');
        return;
      }

      const page = typeof state.eatPage === 'number' ? state.eatPage : 0;
      Pager.go(page, false, true);
      if (pendingRefresh && page === 0) {
        pendingRefresh = false;
        App.reloadData();
      }
    });
  }

  function goHome(refresh) {
    if (App.state.checkinOpen) Checkin.close();
    if (App.state.buddyOpen) Buddy.close();
    if (App.state.radarOpen) Radar.close();
    if (App.state.locOpen) LocDetail.close();
    if (refresh) util.toast('按当前条件换一批');

    if (Pager.index === 0) {
      if (refresh) App.reloadData();
      return;
    }

    const state = history.state || {};
    if (typeof state.eatPage === 'number' && state.eatPage === Pager.index) {
      pendingRefresh = !!refresh;
      history.go(-Pager.index); // 一次退回首页那条历史，逐级返回不刷屏
    } else {
      Pager.go(0, false, true);
      if (refresh) App.reloadData();
    }
  }

  function onPageChange(prev, next) {
    App.state.page = next;
    document.body.dataset.page = String(next);

    const homePane = document.getElementById('pane-home');
    if (prev === 0 && next !== 0 && homePane) homeScrollTop = homePane.scrollTop;
    if (next === 0 && prev !== 0 && homePane) {
      // 等 pager 位移结束再恢复，避免被布局变化重置
      requestAnimationFrame(() => { homePane.scrollTop = homeScrollTop; });
    }

    if (prev === 1 && next !== 1) Detail.onLeave();
    if (next === 1) Detail.onEnter();
    if (next !== 1) Bubbles.pause();
    updateChrome();
  }

  function updateChrome() {
    const page = App.state.page;
    const checkinOpen = App.state.checkinOpen;
    const buddyOpen = App.state.buddyOpen;
    const radarOpen = App.state.radarOpen;
    const locOpen = App.state.locOpen;
    const layerOpen = checkinOpen || buddyOpen || radarOpen || locOpen;

    const homeDock = document.getElementById('homeCta');
    if (homeDock) homeDock.classList.toggle('is-visible', page === 0 && !layerOpen);

    const detailDock = document.getElementById('detailCta');
    if (detailDock) detailDock.classList.toggle('is-visible', page === 1 && !layerOpen);

    const tabbar = document.getElementById('tabbar');
    if (tabbar) {
      const hide = !checkinOpen && !buddyOpen && (radarOpen || locOpen || page !== 0);
      tabbar.classList.toggle('is-hidden', hide);
    }

    if (page !== 0 || layerOpen) hideHint();

    document.querySelectorAll('.tab').forEach((tab) => {
      const key = tab.dataset.tab;
      const isActive =
        (key === 'home' && page === 0 && !checkinOpen && !buddyOpen && !radarOpen && !locOpen) ||
        (key === 'buddies' && buddyOpen) ||
        (key === 'checkin' && checkinOpen);
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  window.Router = {
    init: initHistory,
    navigateTo: navigateTo,
    goHome: goHome,
    onPageChange: onPageChange,
    updateChrome: updateChrome,
    showHint: showHint,
    hideHint: hideHint
  };
})();
