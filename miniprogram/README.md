# 今天吃啥 · 微信小程序（web-view 壳）

用微信小程序 `web-view` 组件内嵌已完成的「今天吃啥」H5，让现有 H5 以小程序形态运行。

## 目录

```text
miniprogram/
├── project.config.json      # 项目配置（appid 用 touristappid 试玩）
├── app.json                 # 单页：pages/webview/webview
├── app.js / app.wxss
├── sitemap.json
└── pages/webview/           # web-view 容器页
```

## 打开方式

1. 安装并打开「微信开发者工具」；
2. 导入项目，选择本目录 `miniprogram/`；
3. AppID 先选「测试号」（`touristappid`），本地预览即可编译运行；
4. 本地预览时若报域名校验，勾选「详情 → 本地设置 → 不校验合法域名」。

## 上线前必须完成

1. **替换 AppID**：在微信公众平台注册小程序，把 `project.config.json` 的 `appid` 换成你的真实 AppID；
2. **web-view 业务域名**：把 `pages/webview/webview.js` 里的 `APP_URL` 换成你自己**已备案 + 已配置为业务域名**的 HTTPS 地址；并在小程序后台「开发 → 开发设置 → 业务域名」配置，域名根目录需放置校验文件；
3. 当前 WorkBuddy 托管域名不能直接作为业务域名（无法在其根目录放置校验文件）。

## 说明

- 本壳是「把 H5 快速套成小程序」的过渡方案：功能与 H5 完全一致，但受 `web-view` 限制（无法用小程序原生能力，导航/分享等体验受限）；
- 若要「原生小程序」（WXML/WXSS/JS 重写、用小程序原生组件与云能力），需要另行原生重构；WorkBuddy 的小程序原生脚手架模板当前存在哈希校验缺陷，待修复后可按标准流程生成。
