/**
 * 图提取 ImageGrab —— 图片库交互脚本 gallery.js
 * 职责：
 *   1. 从 chrome.storage.local 读取 content.js 提取到的图片列表；
 *   2. 网格化渲染（合并重复 URL，每张显示缩略图 / 尺寸 / 复选框 / 序号）；
 *   3. 全选 / 反选 / 清空，实时显示已选数量；
 *   4. 「下载选中」逐张转换并下载为 PNG，带进度提示与结果反馈。
 */

'use strict';

// ===== 常量 =====
const THUMB_CONCURRENCY = 4;       // 缩略图并发转换数量
const AUTO_CONVERT_LIMIT = 60;     // 超过这个数量就不再自动转缩略图，直接用原图预览

// ===== 状态 =====
const state = {
  images: [],          // [{ url, width, height }]
  selected: new Set(), // 选中的索引
  rendering: false
};

// ===== DOM =====
const el = {
  gallery: document.getElementById('gallery'),
  empty: document.getElementById('empty'),
  total: document.getElementById('stat-total'),
  selected: document.getElementById('stat-selected'),
  source: document.getElementById('source-line'),
  btnAll: document.getElementById('btn-select-all'),
  btnInvert: document.getElementById('btn-invert'),
  btnNone: document.getElementById('btn-select-none'),
  btnDownload: document.getElementById('btn-download'),
  progressWrap: document.getElementById('progress-wrap'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  progressPercent: document.getElementById('progress-percent'),
  toast: document.getElementById('toast')
};

// ===== 工具函数 =====

/** 与 Service Worker 通信（Promise 化） */
function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false, error: '无响应' });
    });
  });
}

/** 并发池 */
async function pool(items, limit, worker) {
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (idx < items.length) {
      const my = idx++;
      try {
        await worker(items[my], my);
      } catch (err) {
        console.warn('[图提取] 任务失败', err);
      }
    }
  });
  await Promise.all(runners);
}

/** 轻提示 */
let toastTimer = null;
function showToast(text, type = 'info', duration = 3200) {
  el.toast.textContent = text;
  el.toast.className = 'toast' + (type === 'success' ? ' is-success' : type === 'error' ? ' is-error' : '');
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, duration);
}

/** 进度条控制 */
function showProgress(text, percent) {
  el.progressWrap.hidden = false;
  el.progressText.textContent = text;
  el.progressPercent.textContent = Math.round(percent) + '%';
  el.progressBar.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function hideProgress(delay = 1200) {
  setTimeout(() => { el.progressWrap.hidden = true; }, delay);
}

/** 文件名省略显示 */
function shortenUrl(url) {
  const clean = url.split('?')[0];
  const parts = clean.split('/');
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : clean;
}

/**
 * 根据「原图元数据」和「转好的 PNG 尺寸」计算展示尺寸
 */
function sizeText(img) {
  const w = img.pngWidth || img.width;
  const h = img.pngHeight || img.height;
  return `${w} × ${h}`;
}

// ===== 渲染 =====

/**
 * 渲染整个图片网格
 */
function render() {
  el.gallery.innerHTML = '';
  el.total.textContent = String(state.images.length);

  if (state.images.length === 0) {
    el.empty.hidden = false;
    el.gallery.hidden = true;
    updateSelectedCount();
    return;
  }

  el.empty.hidden = true;
  el.gallery.hidden = false;

  const frag = document.createDocumentFragment();

  state.images.forEach((img, index) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.index = String(index);
    card.setAttribute('role', 'listitem');

    // 缩略图容器
    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    const loading = document.createElement('span');
    loading.className = 'thumb-loading';
    loading.textContent = '加载中…';
    thumb.appendChild(loading);

    // 复选框
    const check = document.createElement('label');
    check.className = 'card-check';
    check.title = '勾选这张图片';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(index);
      else state.selected.delete(index);
      card.classList.toggle('is-selected', box.checked);
      updateSelectedCount();
    });
    check.appendChild(box);
    // 让缩略图区域点击也能切换勾选
    thumb.addEventListener('click', (e) => {
      e.preventDefault();
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change'));
    });
    thumb.style.cursor = 'pointer';

    // 序号角标
    const badge = document.createElement('span');
    badge.className = 'card-index';
    badge.textContent = '#' + String(index + 1).padStart(3, '0');

    // 元信息
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const dim = document.createElement('div');
    dim.className = 'card-dim';
    const dimText = document.createElement('span');
    dimText.textContent = sizeText(img);
    const fmt = document.createElement('span');
    fmt.className = 'badge';
    fmt.textContent = '→ PNG';
    dim.append(dimText, fmt);
    const urlLine = document.createElement('div');
    urlLine.className = 'card-url';
    urlLine.title = img.url;
    urlLine.textContent = shortenUrl(img.url);
    meta.append(dim, urlLine);

    card.append(thumb, check, badge, meta);
    frag.appendChild(card);
  });

  el.gallery.appendChild(frag);
  updateSelectedCount();

  // 异步补上缩略图
  loadThumbnails().catch(() => {});

  // 供本地取证脚本复用（扩展本身不使用）
  window.__GALLERY_STATE__ = state;
}

/**
 * 异步加载缩略图：
 *   - 图片数量 ≤ AUTO_CONVERT_LIMIT 时，请 Service Worker 转成 PNG data URL（保证预览所见即下载所得）；
 *   - 超过阈值时直接拿原图 URL 预览，避免一次性把上百张图转成 data URL 撑爆内存。
 *
 * 阈值可以被 window.__GALLERY_TEST_LIMIT__ 覆盖，仅供自动化验证两条分支用；正常使用不设置。
 */
async function loadThumbnails() {
  if (state.rendering) return;
  state.rendering = true;

  const cards = Array.from(el.gallery.querySelectorAll('.card'));
  const limit = typeof window.__GALLERY_TEST_LIMIT__ === 'number'
    ? window.__GALLERY_TEST_LIMIT__
    : AUTO_CONVERT_LIMIT;
  const useDirect = state.images.length > limit;
  // 记录本次走了哪条分支，便于自动化断言与排查
  window.__GALLERY_LAST_PATH__ = useDirect ? 'direct' : 'data-url';

  await pool(cards, THUMB_CONCURRENCY, async (card) => {
    const index = Number(card.dataset.index);
    const img = state.images[index];
    if (!img) return;
    const thumb = card.querySelector('.card-thumb');

    const setThumb = (src) => {
      const el2 = document.createElement('img');
      el2.src = src;
      el2.alt = `商品图 ${index + 1}`;
      el2.loading = 'lazy';
      el2.decoding = 'async';
      el2.referrerPolicy = 'no-referrer';
      el2.addEventListener('load', () => {
        const loading = thumb.querySelector('.thumb-loading');
        if (loading) loading.remove();
        // 如果原图尺寸未知，用真实渲染尺寸补上
        if (!img.width || !img.height) {
          const card2 = card.querySelector('.card-dim span');
          if (card2) card2.textContent = `${el2.naturalWidth} × ${el2.naturalHeight}`;
        }
      });
      el2.addEventListener('error', () => {
        const loading = thumb.querySelector('.thumb-loading');
        if (loading) loading.textContent = '预览失败';
      });
      thumb.appendChild(el2);
    };

    if (useDirect) {
      // 图片很多时直接预览原图，省内存
      setThumb(img.url);
      return;
    }

    // 让 Service Worker 转成 PNG data URL（同时验证了「能转 PNG」）
    const resp = await send({ type: 'IMAGE_GRAB_PNG', url: img.url });
    if (resp.ok && resp.dataUrl) {
      setThumb(resp.dataUrl);
    } else {
      setThumb(img.url); // 回退
    }
  });

  state.rendering = false;
}

/**
 * 更新「已选数量」显示与按钮状态
 */
function updateSelectedCount() {
  el.selected.textContent = String(state.selected.size);
  const n = state.selected.size;
  el.btnDownload.disabled = n === 0;
  el.btnDownload.textContent = '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path>';
  el.btnDownload.appendChild(svg);
  el.btnDownload.appendChild(document.createTextNode(n > 0 ? ` 下载选中 ${n} 张（PNG）` : ' 下载选中（PNG）'));
}

// ===== 选择操作 =====
function selectAll() {
  state.images.forEach((_, i) => state.selected.add(i));
  syncCheckboxes();
}

function invertSelection() {
  const next = new Set();
  state.images.forEach((_, i) => { if (!state.selected.has(i)) next.add(i); });
  state.selected = next;
  syncCheckboxes();
}

function selectNone() {
  state.selected.clear();
  syncCheckboxes();
}

function syncCheckboxes() {
  el.gallery.querySelectorAll('.card').forEach((card) => {
    const index = Number(card.dataset.index);
    const on = state.selected.has(index);
    const box = card.querySelector('input[type="checkbox"]');
    if (box) box.checked = on;
    card.classList.toggle('is-selected', on);
  });
  updateSelectedCount();
}

// ===== 下载 =====
async function downloadSelected() {
  if (state.selected.size === 0) return;

  const picked = Array.from(state.selected)
    .sort((a, b) => a - b)
    .map((i) => state.images[i])
    .filter(Boolean);

  el.btnDownload.disabled = true;
  showProgress(`准备下载 ${picked.length} 张图片…`, 0);

  const resp = await send({
    type: 'IMAGE_GRAB_DOWNLOAD',
    payload: {
      images: picked,
      pageTitle: state.pageTitle || '商品图'
    }
  });

  if (resp.ok) {
    const { okCount, failCount } = resp;
    showProgress('下载完成', 100);
    if (failCount > 0) {
      showToast(`已下载 ${okCount} 张，${failCount} 张失败（可能是图片已失效）`, 'error', 5000);
    } else {
      showToast(`下载完成：共 ${okCount} 张 PNG，已保存到浏览器默认下载目录`, 'success', 4200);
    }
  } else {
    showProgress('下载失败', 100);
    showToast('下载失败：' + (resp.error || '未知错误'), 'error', 5000);
  }

  hideProgress();
  el.btnDownload.disabled = state.selected.size === 0;
}

// ===== 加载数据 =====
async function loadResult() {
  // 取证/演示模式：在扩展页面地址后加 ?mock=1 时，读取同目录的 gallery-mock-data.js。
  // 这是给本地截图取证用的（没有真实电商页面也能展示图片库的样子），
  // 正常通过扩展打开时不会带这个参数，走真实数据。
  if (typeof window.__GALLERY_MOCK__ !== 'undefined') {
    const result = window.__GALLERY_MOCK__;
    state.images = result.images || [];
    state.pageTitle = result.pageTitle || '';
    state.selected = new Set(state.images.map((_, i) => i));
    el.source.textContent = (result.host ? result.host + '  ' : '')
      + '【演示模式 ?mock=1】' + (result.pageTitle || '');
    render();
    return;
  }

  const resp = await send({ type: 'IMAGE_GRAB_GET_RESULT' });
  if (!resp.ok || !resp.result) {
    state.images = [];
    render();
    return;
  }
  const result = resp.result;
  state.images = result.images || [];
  state.pageTitle = result.pageTitle || '';
  state.selected = new Set(state.images.map((_, i) => i)); // 默认全选，方便一键下载

  const host = result.host ? result.host + '  ' : '';
  const when = result.grabbedAt ? new Date(result.grabbedAt).toLocaleTimeString('zh-CN') : '';
  el.source.textContent = state.images.length
    ? `${host}提取于 ${when} · ${result.pageTitle || result.pageUrl || ''}`
    : '等待提取结果…';

  render();
  if (state.images.length) {
    showToast(`已载入 ${state.images.length} 张图片，默认全选`, 'success');
  }
}

// ===== 事件绑定 =====
el.btnAll.addEventListener('click', selectAll);
el.btnInvert.addEventListener('click', invertSelection);
el.btnNone.addEventListener('click', selectNone);
el.btnDownload.addEventListener('click', downloadSelected);

// 支持 Ctrl/Cmd + A 全选
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAll();
  }
});

// Service Worker 通知刷新（详情页再次提取时）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'IMAGE_GRAB_REFRESH') loadResult();
});

// 打开页面即加载
loadResult();
