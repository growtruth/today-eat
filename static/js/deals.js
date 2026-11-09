/* 团购推荐：有真实套餐展示价格，没有则只给平台入口，绝不编造价格 */
(function () {
  'use strict';

  const Deals = {
    cache: {},

    async open(item) {
      if (!item) return;
      const util = App.util;
      const key = item.id + '|' + (item.name || '');
      const city = (App.boot.defaults && App.boot.defaults.city) || '';

      util.loading(true, '正在查这家店的团购…');
      let data = this.cache[key];
      if (!data) {
        try {
          data = await API.deals({ store_id: item.id, name: item.name, city: city });
          this.cache[key] = data;
        } catch (error) {
          util.loading(false);
          util.toast(error.message || '团购暂时查不到');
          return;
        }
      }
      util.loading(false);
      this.render(item, data);
    },

    render(item, data) {
      const util = App.util;
      const body = document.createElement('div');
      const deals = data.items || [];

      if (deals.length) {
        body.innerHTML =
          '<div class="deal-list">' + deals.map((deal) => {
            const off = deal.discount ? Math.round(deal.discount * 100) : 0;
            return '<div class="deal-card">' +
              '<div class="deal-head">' +
              '<span class="deal-platform">' + util.escapeHtml(deal.platformLabel || deal.platform) + '</span>' +
              (off ? '<span class="deal-off">-' + off + '%</span>' : '') +
              '</div>' +
              '<div class="deal-title">' + util.escapeHtml(deal.title || '套餐') + '</div>' +
              (deal.items && deal.items.length
                ? '<p class="deal-items">' + util.escapeHtml(deal.items.join(' · ')) + '</p>'
                : '') +
              '<div class="deal-foot">' +
              '<span class="deal-price">¥' + deal.price +
              (deal.originalPrice ? '<em>¥' + deal.originalPrice + '</em>' : '') + '</span>' +
              (deal.sold ? '<span class="deal-sold">已售 ' + deal.sold + '</span>' : '') +
              '<a class="deal-buy" href="' + util.escapeHtml(deal.url) + '" target="_blank" rel="noopener">去购买</a>' +
              '</div>' +
              '<p class="deal-note">来源：' + util.escapeHtml(this.sourceLabel(deal.source)) +
              ' · 更新于 ' + util.escapeHtml(deal.updatedAt || '—') +
              (deal.validUntil ? ' · 有效期至 ' + util.escapeHtml(deal.validUntil) : '') + '</p>' +
              '</div>';
          }).join('') + '</div>' +
          '<p class="deal-note" style="margin-top:10px">价格由商家或官方接口提供，下单与支付在平台侧完成。</p>';
      } else {
        body.innerHTML =
          '<p class="deal-lead">还没有这家店的合作套餐。下面是各平台的实时团购入口，价格以平台页面为准。</p>' +
          '<div class="deal-links">' + (data.links || []).map((link) => (
            '<a class="deal-link" href="' + util.escapeHtml(link.url) + '" target="_blank" rel="noopener">' +
            '<span>' + util.escapeHtml(link.label) + '</span>' +
            '<em>看团购 ›</em></a>'
          )).join('') + '</div>' +
          '<p class="deal-note">本页不展示未经授权的价格，避免过期或失真的折扣误导。</p>';
      }

      util.openSheet({
        title: '这家店的团购',
        subtitle: item.name,
        body: body,
        actions: [
          {
            label: '决定吃这家',
            onClick: () => {
              if (App.state.current && App.state.current.id === item.id) {
                App.navigateTo(1);
              } else {
                Detail.open(item);
              }
            }
          }
        ]
      });
    },

    sourceLabel(source) {
      return {
        merchant: '商家提供',
        official: '官方接口',
        manual: '人工维护'
      }[source] || (source || '未知来源');
    }
  };

  window.Deals = Deals;
})();
