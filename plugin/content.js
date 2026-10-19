/**
 * 图提取 ImageGrab —— 内容脚本 content.js
 * 职责：
 *   1. 判断当前页面是否为「电商商品详情页」，只有详情页才注入悬浮按钮；
 *   2. 注入右下角圆角悬浮按钮「获取图片」；
 *   3. 点击后扫描页面所有商品图片（img / srcset / data-src / data-lazy-src / 背景图 / 懒加载）；
 *   4. 过滤图标、logo、占位图、1x1 像素图、小于阈值的图片，补全绝对 URL 并去重；
 *   5. 通过 chrome.runtime.sendMessage 把图片列表交给 service worker。
 */

(() => {
  'use strict';

  // ===== 常量配置 =====
  const MIN_SIZE = 100;              // 过滤阈值：宽或高小于 100px 的图片视为图标/占位图
  const BTN_ID = 'imagegrab-float-btn';
  const TIP_ID = 'imagegrab-tip';

  // 只在这些平台注入（与 manifest 的 matches 保持一致，做二次保险）
  const PLATFORM_HOSTS = [
    'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'yangkeduo.com'
  ];

  // 商品详情页的「路径」特征。
  // 为什么不用域名：淘宝首页就是 item.taobao.com 这个域名，详情页同样是这个域名
  // （区别在路径 /item.htm?id=…）。所以只看域名必然把首页也判成详情页——
  // 这个 bug 由 tools/verify_extension.py 真机验证抓出，这里改成只认路径与 DOM。
  const DETAIL_PATH_HINTS = [
    '/item', '/detail', '/product', '/goods', '/sku',
    'item.htm', 'item.html', 'detail.htm', 'detail.html'
  ];

  // 商品详情页 DOM 特征：只保留详情页专属的容器名，
  // 不用 item / product / goods 这类首页也到处都是的通用词
  const DETAIL_DOM_HINTS = [
    'tb-detail', 'tm-detail', 'jd-detail', 'detailmeta', 'j_detail',
    'main-pic', 'mainpic', 'sku-name', 'skuname', 'product-param',
    'item-name', 'itemname', 'price-panel', 'tb-sku'
  ];

  // 明显的非详情页特征（首页 / 列表页 / 搜索页）——命中就直接不注入
  const NOT_DETAIL_HINTS = [
    'tm-home', 'tb-home', 'j_home', 'home-page', 'homepage',
    'search-result', 'search-list', 'searchlist', 'search-page',
    'category', 'cate-', 'breadcrumb-list', 'goodslist', 'goods-list',
    'itemlist', 'item-list', 'product-list', 'productlist'
  ];

  // 明显不是商品图的 URL 关键词，直接排除
  const URL_BLACKLIST = [
    'logo', 'icon', 'sprite', 'avatar', 'qrcode', 'qr-code', 'placeholder',
    'loading', 'default', 'blank', 'pixel', 'spacer', '1x1', 'transparent',
    'btn', 'button', 'arrow', 'close', 'star', 'cart', 'share', 'weibo', 'weixin',
    'sms', 'safe', 'trust', 'logo.png', 'favicon'
  ];

  /**
   * 判断当前站点是否属于支持的平台
   */
  function isSupportedHost() {
    const host = location.hostname;
    return PLATFORM_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  }

  /**
   * 判断当前页面是否像「商品详情页」
   *
   * 策略（三层，避免误判）：
   *   1) 先排除明显的首页 / 列表页 / 搜索页；
   *   2) 路径里出现详情页专属关键词（/item、/detail、item.htm…）；
   *   3) 或者页面上出现两个以上「详情页专属」容器名。
   *
   * 刻意不看域名，也不使用 item / product / goods 这类宽泛词：淘宝首页就是
   * item.taobao.com，详情页同域名只差路径，只看域名/宽泛词会把首页也判成详情页
   * （该 bug 由 tools/verify_extension.py 真机验证抓出）。
   */
  function looksLikeDetailPage() {
    // 1) 收集页面上的 class/id 标记
    const nodes = document.querySelectorAll('[class],[id]');
    const limit = Math.min(nodes.length, 4000);
    const tokens = [];
    for (let i = 0; i < limit; i++) {
      const token = ((nodes[i].className || '') + ' ' + (nodes[i].id || '')).toString().toLowerCase();
      if (token) tokens.push(token);
    }

    // 2) 非详情页特征先排除
    if (tokens.some((t) => NOT_DETAIL_HINTS.some((k) => t.includes(k)))) return false;

    // 3) 路径特征
    const path = (location.pathname + location.search).toLowerCase();
    if (DETAIL_PATH_HINTS.some((k) => path.includes(k))) return true;

    // 4) DOM 特征：命中两个以上详情页专属容器名
    let hits = 0;
    for (const token of tokens) {
      if (DETAIL_DOM_HINTS.some((k) => token.includes(k))) {
        hits++;
        if (hits >= 2) return true;
      }
    }
    return false;
  }

  /**
   * 补全相对路径为绝对 URL
   */
  function toAbsolute(url) {
    if (!url) return '';
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return '';
    }
  }

  /**
   * 清洗 URL：去掉无意义的占位、过滤黑名单、只保留 http(s) 与 data:image
   */
  function isUsableUrl(url) {
    if (!url) return false;
    if (url.startsWith('data:')) return url.startsWith('data:image/');
    if (!/^https?:/i.test(url)) return false;
    const lower = url.toLowerCase();
    // 黑名单命中（排除掉正常商品图里可能带这些词的极端情况，做后缀边界判断）
    if (URL_BLACKLIST.some((k) => lower.includes(k))) return false;
    // 常见的小尺寸参数，例如 _50x50.jpg、w=50&h=50
    if (/[_\-.](1|2|3|4|5|6|8|10|12|16|20|24|30|32|40|48|50|60|64|80|90)x(1|2|3|4|5|6|8|10|12|16|20|24|30|32|40|48|50|60|64|80|90)\b/i.test(lower)) {
      return false;
    }
    return true;
  }

  /**
   * 从 srcset 中取出分辨率最高的候选 URL
   */
  function pickFromSrcset(srcset) {
    if (!srcset) return '';
    const parts = srcset.split(',').map((s) => s.trim()).filter(Boolean);
    let best = '';
    let bestScore = -1;
    for (const p of parts) {
      const seg = p.split(/\s+/);
      const url = seg[0];
      const desc = seg[1] || '';
      let score = 1;
      const m = /^(\d+)(w|x)$/.exec(desc);
      if (m) score = parseInt(m[1], 10) * (m[2] === 'x' ? 100 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best;
  }

  /**
   * 收集页面中所有候选图片 URL（含懒加载多属性兼容）
   */
  function collectCandidates() {
    const list = [];
    const push = (u) => {
      const abs = toAbsolute(u);
      if (isUsableUrl(abs)) list.push(abs);
    };

    // 1) <img>：覆盖 src / srcset / 各类懒加载属性（不同平台命名不一样，全部兼容）
    const LAZY_ATTRS = [
      'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload',
      'data-lazyload', 'data-url', 'data-image', 'data-img', 'data-pic',
      'data-actualsrc', 'data-echo', 'lazy-src', 'data-srcset', 'data-lazy'
    ];
    document.querySelectorAll('img').forEach((img) => {
      push(img.currentSrc || '');
      push(img.getAttribute('src') || '');
      push(pickFromSrcset(img.getAttribute('srcset') || ''));
      push(pickFromSrcset(img.getAttribute('data-srcset') || ''));
      LAZY_ATTRS.forEach((attr) => {
        const v = img.getAttribute(attr);
        if (v) push(pickFromSrcset(v) || v);
      });
      // 图片自身的宽高（有些图还没加载完，尺寸未知，交给后续自然尺寸校验兜底）
    });

    // 2) <source> 标签（picture / video 封面）
    document.querySelectorAll('source').forEach((s) => {
      push(pickFromSrcset(s.getAttribute('srcset') || ''));
      push(s.getAttribute('src') || '');
    });

    // 3) 所有元素的 CSS 背景图（详情页大图经常是背景图实现）
    const all = document.querySelectorAll('div,section,a,li,span,p,td,figure');
    const limit = Math.min(all.length, 6000);
    for (let i = 0; i < limit; i++) {
      const style = getComputedStyle(all[i]);
      const bg = style.backgroundImage;
      if (!bg || bg === 'none') continue;
      const matches = bg.match(/url\((['"]?)(.*?)\1\)/g) || [];
      matches.forEach((m) => {
        const url = m.replace(/^url\((['"]?)/, '').replace(/(['"]?)\)$/, '');
        push(url);
      });
    }

    // 4) <a href> 指向图片资源的情况（部分平台的原图链接）
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i.test(href)) push(href);
    });

    return list;
  }

  /**
   * 触发懒加载：滚动整页，让懒加载图片真正加载出来
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function triggerLazyLoad(onProgress) {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.9));
    const startX = window.scrollX;
    const startY = window.scrollY;
    let y = 0;
    let guard = 0; // 防止页面高度无限增长导致死循环
    while (guard++ < 400) {
      // 每一轮都重新读取页面高度：懒加载会让详情页不断变长
      const total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      if (y >= total) break;
      window.scrollTo(startX, y);
      await sleep(120);
      y += step;
      if (onProgress) onProgress(Math.min(100, Math.round((y / Math.max(total, 1)) * 100)));
    }
    window.scrollTo(startX, startY); // 回到原位置，不打扰用户
    await sleep(200);
  }

  /**
   * 校验图片真实尺寸，过滤掉小图（图标 / logo / 占位图 / 1x1 像素图）
   * 返回 { ok, width, height, naturalWidth, naturalHeight }
   */
  function probeImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      const done = (ok, w, h) => resolve({ ok, width: w, height: h, url });
      const timer = setTimeout(() => done(false, 0, 0), 8000);
      img.onload = () => {
        clearTimeout(timer);
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        // 过滤 1x1、极小图、以及长宽比例异常的细长装饰条
        const tooSmall = w < MIN_SIZE || h < MIN_SIZE;
        const isPixel = w <= 2 || h <= 2;
        const weirdRatio = (w / Math.max(h, 1) > 20) || (h / Math.max(w, 1) > 20);
        done(!tooSmall && !isPixel && !weirdRatio, w, h);
      };
      img.onerror = () => {
        clearTimeout(timer);
        done(false, 0, 0);
      };
      img.src = url;
    });
  }

  /**
   * 并发池：限制并发数量，避免一次性发几百个请求把页面拖死
   */
  async function pool(items, limit, worker, onTick) {
    const results = [];
    let idx = 0;
    let finished = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (idx < items.length) {
        const my = idx++;
        results[my] = await worker(items[my], my);
        finished++;
        if (onTick) onTick(finished, items.length);
      }
    });
    await Promise.all(runners);
    return results;
  }

  // ===== UI：悬浮按钮 + 提示条 =====

  function ensureStylesInjected() {
    // content.css 已由 manifest 注入，这里只做兜底（防止某些页面样式被覆盖）
    if (document.getElementById('imagegrab-style-guard')) return;
    const guard = document.createElement('style');
    guard.id = 'imagegrab-style-guard';
    guard.textContent = `
      #${BTN_ID}{position:fixed !important;right:24px !important;bottom:28px !important;z-index:2147483600 !important;}
      #${TIP_ID}{position:fixed !important;right:24px !important;bottom:92px !important;z-index:2147483600 !important;}
    `;
    document.documentElement.appendChild(guard);
  }

  function createButton() {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = '提取当前商品详情页的所有图片';
    btn.innerHTML = `
      <span class="imagegrab-btn-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="3"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <path d="M21 15l-5-5L5 21"></path>
        </svg>
      </span>
      <span class="imagegrab-btn-text">获取图片</span>
    `;
    btn.addEventListener('click', onButtonClick);

    ensureStylesInjected();
    document.body.appendChild(btn);
  }

  function showTip(text, type = 'info', autoHide = 0) {
    let tip = document.getElementById(TIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = TIP_ID;
      document.body.appendChild(tip);
    }
    tip.className = 'imagegrab-tip imagegrab-tip--' + type;
    tip.innerHTML = `<span class="imagegrab-tip-dot"></span><span>${text}</span>`;
    tip.style.display = 'flex';
    if (autoHide > 0) {
      clearTimeout(tip._timer);
      tip._timer = setTimeout(() => { tip.style.display = 'none'; }, autoHide);
    }
  }

  function setButtonBusy(busy, text) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
    const t = btn.querySelector('.imagegrab-btn-text');
    if (t) t.textContent = text || (busy ? '提取中…' : '获取图片');
  }

  /**
   * 点击按钮的主流程
   */
  async function onButtonClick() {
    if (window.__imagegrab_running) return;
    window.__imagegrab_running = true;
    setButtonBusy(true, '提取中…');
    showTip('正在触发懒加载并扫描页面图片…');

    try {
      // 第 1 步：滚动触发懒加载
      await triggerLazyLoad((p) => showTip(`正在触发懒加载… ${p}%`));

      // 第 2 步：收集候选 URL 并去重
      const candidates = Array.from(new Set(collectCandidates()));
      showTip(`共发现 ${candidates.length} 个候选图片，正在校验尺寸…`);

      // 第 3 步：并发校验真实尺寸，过滤小图
      const probed = await pool(candidates, 8, probeImage, (done, total) => {
        if (done % 10 === 0 || done === total) {
          showTip(`正在校验图片尺寸… ${done}/${total}`);
        }
      });
      const valid = probed.filter((p) => p && p.ok);

      // 同时把页面上真实渲染尺寸也带进去，方便 gallery 展示
      const images = valid.map((p) => ({
        url: p.url,
        width: p.width,
        height: p.height
      }));

      if (images.length === 0) {
        setButtonBusy(false);
        showTip('没有找到符合尺寸要求的商品图片，请确认当前是商品详情页', 'error', 5000);
        return;
      }

      // 第 4 步：交给 service worker 打开图片库
      showTip(`已提取 ${images.length} 张图片，正在打开图片库…`, 'success');
      chrome.runtime.sendMessage(
        {
          type: 'IMAGE_GRAB_RESULT',
          payload: {
            images,
            pageUrl: location.href,
            pageTitle: document.title,
            host: location.hostname
          }
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            showTip('打开图片库失败：' + (chrome.runtime.lastError?.message || resp?.error || '未知错误'), 'error', 5000);
            setButtonBusy(false);
            return;
          }
          setButtonBusy(false);
          showTip(`已打开图片库，共 ${images.length} 张图片`, 'success', 3000);
        }
      );
    } catch (err) {
      console.error('[图提取] 提取失败：', err);
      setButtonBusy(false);
      showTip('提取失败：' + (err && err.message ? err.message : err), 'error', 5000);
    } finally {
      window.__imagegrab_running = false;
    }
  }

  // ===== 入口 =====
  function init() {
    if (!isSupportedHost()) return;
    // 详情页才显示按钮
    if (!looksLikeDetailPage()) return;
    createButton();

    // 单页应用路由切换后，按钮可能被清除，做一次低频守护
    const guard = setInterval(() => {
      if (!document.getElementById(BTN_ID) && looksLikeDetailPage()) createButton();
    }, 3000);
    window.addEventListener('beforeunload', () => clearInterval(guard));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // ===== 导出给本地取证页使用（不影响扩展本身运行） =====
  // 03_本地测试 下的取证页会直接复用这里的真实函数跑一遍提取流程，
  // 保证截图里的数据是真的由 content.js 逻辑产生，而不是手写的假数据。
  if (typeof window !== 'undefined') {
    window.__IMAGEGRAB_TEST__ = {
      MIN_SIZE,
      isUsableUrl,
      toAbsolute,
      pickFromSrcset,
      collectCandidates,
      triggerLazyLoad,
      probeImage,
      pool,
      looksLikeDetailPage,
      isSupportedHost
    };
  }
})();
