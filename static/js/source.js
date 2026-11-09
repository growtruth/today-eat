/* 数据来源说明：来源、范围、频率、校验与合规边界 */
(function () {
  'use strict';

  const App = window.App;
  const util = App.util;

  async function open() {
    util.loading(true, '正在读取采集说明…');
    let data = null;
    try {
      data = await API.sources(App.state.sourceInfo ? App.state.sourceInfo.source : '');
    } catch (e) {
      util.toast('采集说明暂时读不到');
      util.loading(false);
      return;
    }
    util.loading(false);

    const body = document.createElement('div');
    const active = data.active;
    const sourceHtml = (data.sources || []).map((source) => {
      const isActive = source.key === active;
      return '<div class="source-item">' +
        '<div class="source-name">' + util.escapeHtml(source.name) +
        (isActive ? '<span class="source-tag">当前使用</span>' : '') +
        (source.key === 'demo' ? '<span class="source-tag is-demo">演示</span>' : '') +
        '</div>' +
        '<p class="source-desc">采集范围：' + util.escapeHtml(source.scope) + '</p>' +
        '<p class="source-desc">解析字段：' + util.escapeHtml((source.fields || []).join('、')) + '</p>' +
        '<p class="source-desc">许可：' + util.escapeHtml(source.license) + '</p>' +
        '<div class="source-meta"><span>最小间隔 ' + source.minInterval + 's</span>' +
        '<span>' + (source.requiresKey ? '需要申请 Key' : '无需 Key') + '</span></div>' +
        '</div>';
    }).join('');

    body.innerHTML =
      sourceHtml +
      '<div class="source-policy">' +
      '<b>请求频率</b>：高德/百度 1 秒/次，OSM 3 秒/次，按 host 串行；失败指数退避重试 ≤2 次，单次超时 6 秒。<br>' +
      '<b>覆盖范围</b>：以定位点为圆心，3km → 5km → 8km 逐级扩大。<br>' +
      '<b>准确性校验</b>：坐标必须落在国内范围、评分 0~5、人均 1~5000、距离本地复算、同名 45 米内去重。<br>' +
      '<b>合规边界</b>：不抓取小红书、美团、大众点评、抖音的单条内容；评价仅使用地图 POI 公开摘要，并保留跳转原平台的入口。' +
      '</div>' +
      '<div class="source-policy">' +
      '<b>说明</b>：演示模式使用项目自建示例数据（16 家望京门店），图片取自需求包实拍参考素材；' +
      '接入真实 Key 后，商家图片直接使用 POI 接口返回的公开图片 URL 渲染。' +
      '</div>';

    util.openSheet({
      title: '数据从哪来',
      subtitle: '来源、范围、频率与校验规则都在这里',
      body: body,
      actions: [{ label: '知道了', variant: 'ghost' }]
    });
  }

  window.SourceSheet = { open: open };
})();
