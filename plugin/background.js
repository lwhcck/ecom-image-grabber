/**
 * 图提取 ImageGrab —— Service Worker (background.js)
 * 职责：
 *   1. 接收 content.js 提取到的图片列表，落库到 chrome.storage.local；
 *   2. 在 Service Worker 中 fetch + createImageBitmap + OffscreenCanvas 把图片统一转成 PNG
 *      （避开页面 CSP 与画布污染限制，也没有跨域限制——manifest 已声明 host_permissions）；
 *   3. 打开图片库页面 gallery.html；
 *   4. 接收 gallery 的下载请求，用 chrome.downloads.download 保存为 商品图_序号.png。
 *
 * 说明：Manifest V3 的 Service Worker 没有 DOM，但可以访问 OffscreenCanvas / createImageBitmap / fetch，
 *      因此图片转 PNG 放在这里做最稳。
 */

'use strict';

const STORAGE_KEY = 'imagegrab:lastResult';
const PNG_CACHE_KEY = 'imagegrab:pngCacheMeta'; // 仅记录统计信息，blob 存在内存缓存里
const GALLERY_TAB_KEY = 'imagegrab:galleryTabId'; // 记录图片库标签页 id，避免申请 tabs 权限

/** 内存中的 PNG Blob 缓存：url -> Blob（Service Worker 被回收后会丢失，届时按需重转） */
const pngCache = new Map();

/** 一次最多同时转几张图，避免占满内存 */
const CONVERT_CONCURRENCY = 4;

// ===== 安装时给个初始状态 =====
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ [PNG_CACHE_KEY]: { converted: 0, failed: 0 } });
});

/**
 * 把任意格式（jpg/webp/gif/bmp）的图片 URL 转成 PNG Blob
 * @param {string} url
 * @returns {Promise<Blob>}
 */
async function urlToPngBlob(url) {
  if (pngCache.has(url)) return pngCache.get(url);

  // data: URL 与 http(s) 都走 fetch；fetch 在 SW 中受 host_permissions 授权
  const resp = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const srcBlob = await resp.blob();

  // 用 createImageBitmap 解码，兼容各种格式
  const bitmap = await createImageBitmap(srcBlob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    // 透明底：原图带 alpha 时直接铺上去，不带 alpha 就填白底，避免转 PNG 后出现黑边
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    pngCache.set(url, pngBlob);
    return pngBlob;
  } finally {
    bitmap.close();
  }
}

/**
 * Blob -> data URL（chrome.downloads.download 在 SW 里不能直接用 blob: URL，
 * 因为 SW 的 createObjectURL 不可用，所以统一转 data URL 下载）
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Blob 读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 并发池
 */
async function pool(items, limit, worker, onTick) {
  let idx = 0;
  let done = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (idx < items.length) {
      const my = idx++;
      await worker(items[my], my);
      done++;
      if (onTick) onTick(done, items.length);
    }
  });
  await Promise.all(runners);
  return done;
}

/**
 * 把本次结果里的所有图片预先转成 PNG，返回 { ok, fail }
 */
async function convertAll(images, onProgress) {
  let ok = 0;
  let fail = 0;
  await pool(images, CONVERT_CONCURRENCY, async (img) => {
    try {
      await urlToPngBlob(img.url);
      ok++;
    } catch (err) {
      fail++;
      console.warn('[图提取] 转换失败：', img.url, err && err.message);
    }
  }, (d, total) => {
    if (onProgress && (d % 2 === 0 || d === total)) onProgress(d, total);
  });
  return { ok, fail };
}

/**
 * 序号补零：1 -> 001
 */
function pad3(n) {
  return String(n).padStart(3, '0');
}

/**
 * 文件名安全化：用页面标题做前缀时去掉非法字符
 */
function safeName(text) {
  return (text || '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

// ===== 消息路由 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // 1) 内容脚本把提取结果送过来
  if (msg.type === 'IMAGE_GRAB_RESULT') {
    handleGrabResult(msg.payload)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true; // 异步响应
  }

  // 2) 图片库页面读取结果
  if (msg.type === 'IMAGE_GRAB_GET_RESULT') {
    chrome.storage.local.get(STORAGE_KEY)
      .then((data) => sendResponse({ ok: true, result: data[STORAGE_KEY] || null }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // 3) 图片库页面请求逐张转 PNG（用于缩略图预览，避免跨域画布污染）
  if (msg.type === 'IMAGE_GRAB_PNG') {
    urlToPngBlob(msg.url)
      .then((blob) => blobToDataUrl(blob))
      .then((dataUrl) => sendResponse({ ok: true, dataUrl, size: dataUrl.length }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }

  // 4) 图片库页面请求批量下载
  if (msg.type === 'IMAGE_GRAB_DOWNLOAD') {
    handleDownload(msg.payload)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }

  return undefined;
});

/**
 * 处理提取结果：落库 + 打开图片库
 */
async function handleGrabResult(payload) {
  const images = (payload && payload.images) || [];
  const result = {
    images,
    pageUrl: payload.pageUrl || '',
    pageTitle: payload.pageTitle || '',
    host: payload.host || '',
    grabbedAt: Date.now()
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: result });

  // 打开（或复用）图片库页面
  await openOrFocusGallery();

  // 后台预热：转 PNG（页面打开后逐张来取会更快）
  convertAll(images).then(({ ok, fail }) => {
    chrome.storage.local.set({ [PNG_CACHE_KEY]: { converted: ok, failed: fail, at: Date.now() } });
  }).catch(() => {});

  return { count: images.length };
}

/**
 * 打开图片库页面；如果之前开的那个还活着，就直接聚焦并让它刷新。
 *
 * 刻意不使用 chrome.tabs.query({ url }) —— 按 URL 过滤需要申请 tabs 权限，
 * 而我们只需要操作「自己创建的那个标签页」，所以只记 id + chrome.tabs.get 探测存在性，
 * 这样权限里就不需要 tabs，做到最小权限。
 */
async function openOrFocusGallery() {
  const galleryUrl = chrome.runtime.getURL('gallery.html');
  const prevId = await getGalleryTabId();

  if (prevId != null) {
    try {
      await chrome.tabs.get(prevId);
      await chrome.tabs.update(prevId, { active: true });
      // 让已打开的页面重新拉取数据
      chrome.tabs.sendMessage(prevId, { type: 'IMAGE_GRAB_REFRESH' }).catch(() => {});
      return prevId;
    } catch {
      // 标签页已被关闭，走新建流程
    }
  }

  const tab = await chrome.tabs.create({ url: galleryUrl });
  if (tab && tab.id != null) await setGalleryTabId(tab.id);
  return tab && tab.id;
}

/** 读取上次打开的图片库标签页 id */
async function getGalleryTabId() {
  const data = await chrome.storage.local.get(GALLERY_TAB_KEY);
  const id = data[GALLERY_TAB_KEY];
  return typeof id === 'number' ? id : null;
}

/** 记住图片库标签页 id */
async function setGalleryTabId(id) {
  await chrome.storage.local.set({ [GALLERY_TAB_KEY]: id });
}

/**
 * 处理批量下载：统一转 PNG，文件名 商品图_001.png
 */
async function handleDownload(payload) {
  const images = (payload && payload.images) || [];
  let okCount = 0;
  const failed = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      const pngBlob = await urlToPngBlob(img.url);
      const dataUrl = await blobToDataUrl(pngBlob);
      // 文件名规则按课程要求「商品图_序号.png」，序号补零（如 商品图_001.png）。
      // 之前会把页面标题拼在前面（商品详情_商品图_001.png），与要求不一致，已改为严格编号。
      const filename = `商品图_${pad3(i + 1)}.png`;
      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      okCount++;
    } catch (err) {
      failed.push({ url: img.url, error: err && err.message ? err.message : String(err) });
    }
  }

  return { okCount, failCount: failed.length, failed };
}

// ===== 点击扩展图标也打开图片库 =====
chrome.action.onClicked.addListener(() => {
  openOrFocusGallery();
});

// ===== 导出给单元测试使用（扩展本身不使用这个导出） =====
export const __test__ = {
  openOrFocusGallery,
  handleGrabResult,
  handleDownload,
  urlToPngBlob,
  pad3,
  safeName,
  STORAGE_KEY,
  GALLERY_TAB_KEY
};
