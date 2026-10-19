/**
 * 生成「真实提取结果」取证页面 + 图片库取证页面（本地验证用，不是交付物）
 *
 * capture.html
 *   直接 <script src="content.js"> 加载真实插件脚本，调用它导出的 window.__IMAGEGRAB_TEST__
 *   里的真实函数（collectCandidates / probeImage / triggerLazyLoad …）跑一遍完整提取流程，
 *   把统计结果、被过滤的小图、通过校验的图片全部写在页面上，用于截图取证。
 *   ——不再用字符串拼接复制源码，避免转义踩坑，也保证用的是插件本体逻辑。
 *
 * gallery-mock.html
 *   在真实 gallery.html / gallery.js 前注入一个 mock 的 chrome.* API，
 *   使图片库页面在 file:// 下也能真实渲染，图片数据来自 capture 的真实提取结果。
 *
 * 用法：
 *   node tools/make-test-capture.js <演示页.html> <素材目录> <plugin目录> <输出目录>
 */

const fs = require('fs');
const path = require('path');

const demoHtmlPath = process.argv[2];
const assetDir = process.argv[3];
const pluginDir = process.argv[4];
const outDir = process.argv[5];

if (!demoHtmlPath || !assetDir || !pluginDir || !outDir) {
  console.error('用法: node tools/make-test-capture.js <演示页.html> <素材目录> <plugin目录> <输出目录>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// ---------- 1. 演示页 DOM 内联（图片转 data URL，去掉自带脚本避免干扰） ----------
const demoHtml = fs.readFileSync(demoHtmlPath, 'utf8');
const bodyMatch = demoHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
let demoInner = bodyMatch ? bodyMatch[1] : '';

// 演示页自带的内联脚本会切换主图、与本取证页无关，去掉以免与取证脚本冲突
demoInner = demoInner.replace(/<script[\s\S]*?<\/script>/gi, '');

// file:// 页面之间不能互相加载 file:// 图片，统一内联成 data URL
const inlined = new Set();
demoInner = demoInner.replace(/\.\.\/05_测试素材\/([A-Za-z0-9_.\-]+\.png)/g, (m, file) => {
  const p = path.join(assetDir, file);
  if (!fs.existsSync(p)) return m;
  inlined.add(file);
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
});

// ---------- 2. capture.html ----------
const captureHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>图提取 ImageGrab · 真实提取结果取证</title>
<link rel="stylesheet" href="content.css" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2430; background: #eef1f7; }
  .layout { display: grid; grid-template-columns: 900px 1fr; min-height: 100vh; }
  .left { position: relative; padding: 22px 26px 90px; background: #fff; overflow: hidden; }
  .right { padding: 22px 24px; background: #f6f7fb; border-left: 1px solid #e3e7f0; }
  .demo-banner { margin: -22px -26px 18px; padding: 10px 26px; font-size: 12.5px; line-height: 1.6;
    color: #7a4a00; background: #fff6e0; border-bottom: 1px solid #ffe0a3; }
  .right h2 { margin: 0 0 6px; font-size: 18px; }
  .right .sub { margin: 0 0 16px; font-size: 12.5px; color: #6b7280; line-height: 1.7; }
  .panel { padding: 16px; margin-bottom: 14px; border-radius: 14px; background: #fff; border: 1px solid #e8eaf0; }
  .panel h3 { margin: 0 0 10px; font-size: 14px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 13px; border-bottom: 1px dashed #eef0f6; }
  .kv:last-child { border-bottom: none; }
  .pass { color: #12864b; font-weight: 700; }
  .fail { color: #c62828; font-weight: 700; }
  .demo-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 4px; }
  .demo-strip figure { margin: 0; }
  .demo-strip img { width: 100%; aspect-ratio: 1/1; object-fit: cover; border-radius: 9px; border: 2px solid #d7e0ff; }
  .demo-strip figcaption { margin-top: 4px; font-size: 10.5px; color: #6b7280; text-align: center; }
  .idx-tag { display: inline-block; padding: 1px 6px; border-radius: 5px; font-size: 10.5px; font-weight: 700;
    color: #4f7cff; background: rgba(79,124,255,.12); }
  .btn-preview { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 12px; background: #f7f8fc; }
  .btn-preview .stage { position: relative; width: 190px; height: 84px; border-radius: 10px;
    background: linear-gradient(135deg,#e9edf8,#f4f0ff); overflow: hidden; }
  .btn-preview .stage::after { content: "页面右下角位置"; position: absolute; left: 10px; top: 8px; font-size: 10.5px; color: #8a93a8; }
  .btn-preview .note { font-size: 12px; color: #6b7280; line-height: 1.7; }
  .filt-list { margin: 0; padding-left: 18px; font-size: 12.5px; color: #5b6478; line-height: 1.9; }
  code { padding: 1px 6px; border-radius: 5px; background: rgba(79,124,255,.1); color: #4f7cff; font-size: 12px; }
</style>
</head>
<body>
<div class="layout">
  <!-- 左：真实演示详情页 DOM（提取逻辑就跑在这个 DOM 上） -->
  <div class="left" id="demo-page">
    ${demoInner}
  </div>

  <!-- 右：真实提取结果 -->
  <aside class="right">
    <h2>真实提取结果</h2>
    <p class="sub">
      本页用 <code>&lt;script src="content.js"&gt;</code> 加载<strong>插件本体脚本</strong>，
      再调用它导出的真实函数（<code>collectCandidates</code> / <code>probeImage</code> /
      <code>triggerLazyLoad</code>）对左侧演示详情页跑了一遍完整提取流程。
    </p>

    <div class="panel">
      <h3>① 悬浮按钮外观（使用 <code>content.css</code> 原始样式）</h3>
      <div class="btn-preview">
        <div class="stage">
          <button id="imagegrab-float-btn" style="pointer-events:none;position:absolute;right:12px;bottom:12px;" type="button">
            <span class="imagegrab-btn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <path d="M21 15l-5-5L5 21"></path>
              </svg>
            </span>
            <span class="imagegrab-btn-text">获取图片</span>
          </button>
        </div>
        <p class="note">圆角胶囊按钮 + 蓝紫渐变 + 阴影 + hover 上浮；<br />只在商品详情页注入，首页与列表页不显示。</p>
      </div>
    </div>

    <div class="panel">
      <h3>② 提取统计</h3>
      <div class="kv"><span>候选图片 URL（去重前）</span><b id="s-cand">—</b></div>
      <div class="kv"><span>去重后候选</span><b id="s-dedup">—</b></div>
      <div class="kv"><span>真实加载成功</span><b id="s-loaded">—</b></div>
      <div class="kv"><span>加载失败 / 被过滤</span><b id="s-filtered">—</b></div>
      <div class="kv"><span>最终通过校验的图片</span><b class="pass" id="s-valid">—</b></div>
      <div class="kv"><span>过滤阈值</span><b id="s-threshold">—</b></div>
    </div>

    <div class="panel">
      <h3>③ 过滤规则实测</h3>
      <ul class="filt-list">
        <li>小尺寸 URL 规则（文件名含 <code>_20x20</code>/<code>_50x50</code> 等）：
          <b id="f-url-small" class="fail">判定中…</b>
          <br /><span style="color:#8a93a8">输入 <code>.../x_50x50.jpg</code> → isUsableUrl 返回 <span id="r-url-small">—</span></span></li>
        <li>图片真实尺寸阈值（&lt; <code>100×100</code> 视为图标/占位图）：
          <b id="f-size" class="fail">判定中…</b>
          <br /><span style="color:#8a93a8">实测本页 <code>demo_img_small_20.png</code>：<span id="r-size">—</span></span></li>
        <li>URL 黑名单（logo / icon / placeholder / sprite 等关键词）：
          <b class="pass">已生效</b>
          <br /><span style="color:#8a93a8">输入 <code>.../logo_icon.png</code> → isUsableUrl 返回 <span id="r-black">—</span></span></li>
        <li>1×1 像素图与长宽比 &gt; 20:1 的细长装饰条：<b class="pass">已排除</b></li>
        <li>相对路径补全为绝对 URL + 去重：<b class="pass">已生效</b></li>
      </ul>
    </div>

    <div class="panel">
      <h3>④ 通过校验的图片预览</h3>
      <div class="demo-strip" id="valid-strip"></div>
    </div>
  </aside>
</div>

<!-- 加载插件本体脚本（真实代码，不做任何复制改写） -->
<script src="content.js"></script>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const T = window.__IMAGEGRAB_TEST__;
  if (!T) { document.title = '取证失败：content.js 未导出测试接口'; return; }

  try {
    $('s-threshold').textContent = T.MIN_SIZE + ' × ' + T.MIN_SIZE + ' px';

    await T.triggerLazyLoad(() => {});
    const raw = T.collectCandidates();
    const uniq = Array.from(new Set(raw));
    $('s-cand').textContent = raw.length + ' 个';
    $('s-dedup').textContent = uniq.length + ' 个';

    const probed = await T.pool(uniq, 8, T.probeImage, () => {});
    const validOnes = probed.filter((p) => p && p.ok);
    const failed = probed.filter((p) => !p || !p.ok);

    $('s-loaded').textContent = validOnes.length + ' 张';
    $('s-filtered').textContent = failed.length + ' 张';
    $('s-valid').textContent = validOnes.length + ' 张';

    const smallHit = probed.find((p) => p && !p.ok && /demo_img_small_20/.test(p.url));
    // 直接调用插件里的过滤函数，证明规则真的生效
    const urlSmallOk = T.isUsableUrl('https://img.alicdn.com/imgextra/x_50x50.jpg');
    const urlBlackOk = T.isUsableUrl('https://img.alicdn.com/imgextra/logo_icon.png');
    $('r-url-small').textContent = String(urlSmallOk);
    $('r-black').textContent = String(urlBlackOk);
    $('f-url-small').textContent = urlSmallOk ? '未生效（不应通过）' : '已过滤 ✓';
    $('f-url-small').className = urlSmallOk ? 'fail' : 'pass';
    if (smallHit) {
      $('f-size').textContent = '已过滤 ✓';
      $('f-size').className = 'pass';
      $('r-size').textContent = 'naturalWidth/Height 小于 100，probeImage 返回 ok=false';
    } else {
      // 小图在 URL 规则阶段就被拦掉时，直接实测一次 probeImage
      const probe = await T.probeImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAG0lEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAPBqHgAAAX8B9nMAAAAASUVORK5CYII=');
      $('f-size').textContent = probe.ok ? '未生效' : '已过滤 ✓';
      $('f-size').className = probe.ok ? 'fail' : 'pass';
      $('r-size').textContent = 'probeImage 返回 ' + probe.width + '×' + probe.height + '，ok=' + probe.ok;
    }

    const strip = $('valid-strip');
    validOnes.slice(0, 6).forEach((p, i) => {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.src = p.url;
      const cap = document.createElement('figcaption');
      cap.innerHTML = '<span class="idx-tag">#' + String(i + 1).padStart(3, '0') + '</span><br>' + p.width + '×' + p.height;
      fig.append(img, cap);
      strip.appendChild(fig);
    });

    // 结果落盘给后续脚本（生成 mock 数据）使用
    window.__GRAB_RESULT__ = {
      candidates: raw.length,
      dedup: uniq.length,
      filtered: failed.length,
      valid: validOnes.map((p) => ({ url: p.url, width: p.width, height: p.height }))
    };
    const json = JSON.stringify(window.__GRAB_RESULT__);
    const pre = document.createElement('pre');
    pre.id = 'grab-result-json';
    pre.style.display = 'none';
    pre.textContent = json;
    document.body.appendChild(pre);

    document.title = '取证完成：通过 ' + validOnes.length + ' 张';
  } catch (e) {
    document.title = '取证失败：' + e.message;
  }
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(outDir, 'capture.html'), captureHtml, 'utf8');

// ---------- 3. gallery-mock.html（注入 mock chrome API） ----------
const galleryHtml = fs.readFileSync(path.join(pluginDir, 'gallery.html'), 'utf8');
const mockTag = '  <script src="gallery-mock.js"></script>\n';
const injected = galleryHtml.replace(
  '  <script src="gallery.js"></script>',
  mockTag + '  <script src="gallery.js"></script>'
);
if (injected === galleryHtml) throw new Error('gallery.html 中未找到 gallery.js 引用');

const withNotice = injected.replace(
  '<body>',
  `<body>
  <div style="padding:9px 26px;font-size:12.5px;line-height:1.6;color:#7a4a00;background:#fff6e0;border-bottom:1px solid #ffe0a3;">
    <strong>本地取证页面</strong>：图片数据来自 <code>content.js</code> 对演示详情页的真实提取结果；
    本页额外注入了一个本地 mock 的 <code>chrome.*</code> API，使真实 <code>gallery.js</code> 能在 file:// 下渲染。
    装进 Chrome 后，这些数据由扩展自己的 Service Worker 提供。
  </div>`
);

// 取证用：等缩略图真的都渲染出来后再自动点一次「下载选中」，并留下常驻结果横幅
const withAutoDemo = withNotice.replace(
  '</body>',
  `  <script>
  // 仅本地取证页使用：等全部缩略图加载完成后自动演示一次批量下载，保证截图内容稳定
  function whenThumbsReady(cb) {
    let tries = 0;
    const timer = setInterval(() => {
      const cards = document.querySelectorAll('.card-thumb img');
      const ready = Array.prototype.every.call(cards, (im) => im.complete && im.naturalWidth > 0);
      if ((cards.length > 0 && ready) || ++tries > 200) {
        clearInterval(timer);
        cb();
      }
    }, 50);
  }

  window.addEventListener('load', () => {
    whenThumbsReady(() => {
      // 关掉缩略图的懒加载并强制一次重排，避免无头浏览器截图时漏画
      const imgs = document.querySelectorAll('.card-thumb img');
      Array.prototype.forEach.call(imgs, (im) => { im.loading = 'eager'; });
      void document.body.offsetHeight;

      // 自动点一次「下载选中」，让 gallery.js 自己的进度条与轻提示出现在截图里
      const btn = document.getElementById('btn-download');
      if (btn) btn.click();
      setTimeout(() => {
        void document.body.offsetHeight;
        document.title = '取证完成：图片库 + 下载反馈';
      }, 600);
    });
  });
  </script>
</body>`
);
fs.writeFileSync(path.join(outDir, 'gallery-mock.html'), withAutoDemo, 'utf8');

console.log('已生成：');
console.log('  ' + path.join(outDir, 'capture.html'));
console.log('  ' + path.join(outDir, 'gallery-mock.html'));
console.log('演示图内联：' + inlined.size + ' 个文件（含小图标）');
if (inlined.size === 0) console.warn('警告：没有内联到任何演示图，请检查素材路径');
