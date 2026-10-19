/**
 * 图片库演示数据（仅当地址带 ?mock=1 时由 gallery.js 采用）
 *
 * 用途：本地截图取证。没有真实电商账号 / 详情页时，也能展示图片库填充后的样子。
 * 数据来自 content.js 对 03_本地测试/演示商品详情页.html 的真实提取结果
 * （见 03_本地测试/插件取证/capture.html 的统计：候选 22 → 去重 6 → 通过 5）。
 *
 * 正常通过扩展打开图片库时地址不带 ?mock=1，本文件的数据不会被使用。
 */
(function () {
  'use strict';

  // 不是演示模式就直接退出，不污染真实数据
  if (new URLSearchParams(location.search).get('mock') !== '1') return;

  var IMAGES = [
    { url: 'assets/demo_img_01.png', width: 800, height: 800 },
    { url: 'assets/demo_img_02.png', width: 900, height: 1200 },
    { url: 'assets/demo_img_03.png', width: 1000, height: 1000 },
    { url: 'assets/demo_img_04.png', width: 1200, height: 800 },
    { url: 'assets/demo_img_05.png', width: 750, height: 1000 }
  ];

  window.__GALLERY_MOCK__ = {
    images: IMAGES,
    pageUrl: 'https://item.taobao.com/item.htm?id=DEMO',
    pageTitle: '【本地演示】无线蓝牙耳机 主动降噪 长续航 — 商品详情',
    host: 'item.taobao.com',
    grabbedAt: Date.now()
  };
})();
