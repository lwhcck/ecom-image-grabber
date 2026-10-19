/**
 * background.js（Service Worker）单元测试
 *
 * 重点回归：**不得再使用 chrome.tabs.query**。
 * 按 URL 查询标签页需要申请 tabs 权限，而我们已经把 tabs 从 manifest 里去掉、
 * 改成「记住自己创建的标签页 id」的方式，所以这里用守卫把这条约定钉住。
 *
 * 运行：node --test tools/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BG = path.join(HERE, '..', 'plugin', 'background.js');
const MANIFEST = path.join(HERE, '..', 'plugin', 'manifest.json');

const fs = await import('node:fs');

/** 造一个记录调用的 chrome 假实现 */
function makeChromeMock({ tabAlive = true } = {}) {
  const calls = [];
  const storage = new Map();
  const listeners = { message: [], action: [], installed: [] };

  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      getURL: (p) => 'chrome-extension://test/' + p,
      lastError: null
    },
    storage: {
      local: {
        get: async (key) => {
          calls.push(['storage.get', key]);
          if (key == null) return Object.fromEntries(storage);
          if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
          return {};
        },
        set: async (obj) => {
          calls.push(['storage.set', obj]);
          Object.entries(obj).forEach(([k, v]) => storage.set(k, v));
        }
      }
    },
    tabs: {
      // 必须用 get（只按 id 查，不需要 tabs 权限），而不是 query
      get: async (id) => {
        calls.push(['tabs.get', id]);
        if (!tabAlive) throw new Error('No tab with id: ' + id);
        return { id };
      },
      update: async (id, info) => { calls.push(['tabs.update', id, info]); return { id }; },
      create: async (info) => { calls.push(['tabs.create', info]); return { id: 42 }; },
      sendMessage: async (id, msg) => { calls.push(['tabs.sendMessage', id, msg]); return undefined; },
      query: async () => {
        calls.push(['tabs.query', 'CALLED']);
        throw new Error('chrome.tabs.query 被调用了：这需要申请 tabs 权限，已经刻意移除');
      }
    },
    downloads: { download: async () => 1 },
    action: { onClicked: { addListener: (fn) => listeners.action.push(fn) } }
  };

  return { chrome, calls, storage, listeners };
}

/** 在干净环境里加载 background.js，并拿到它的内部函数 */
async function loadBackground({ tabAlive = true } = {}) {
  const mock = makeChromeMock({ tabAlive });
  globalThis.chrome = mock.chrome;
  // 每次都带不同 query，避免 ESM 模块缓存
  const mod = await import(pathToFileURL(BG).href + '?t=' + Date.now() + Math.random());
  // background.js 通过 __test__ 暴露内部函数，避免给扩展增加正式导出
  return { mod: mod.__test__, ...mock };
}

// ===== manifest 权限 =====

test('manifest 不申请 tabs 权限（最小权限）', () => {
  const mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.equal(Array.isArray(mf.permissions), true);
  assert.equal(mf.permissions.includes('tabs'), false, 'tabs 权限应已移除');
  assert.deepEqual(mf.permissions.sort(), ['activeTab', 'downloads', 'scripting', 'storage']);
});

// ===== 回归：不使用 tabs.query =====

test('打开图片库时不调用 chrome.tabs.query', async () => {
  const { mod, calls } = await loadBackground();
  const id = await mod.openOrFocusGallery();
  assert.equal(id, 42, '首次应新建标签页并返回其 id');
  const usedQuery = calls.some((c) => c[0] === 'tabs.query');
  assert.equal(usedQuery, false, '不应该调用 tabs.query（那需要 tabs 权限）');
});

test('第一次打开会记录标签页 id，第二次直接复用并刷新', async () => {
  const { mod, calls, storage } = await loadBackground();

  const first = await mod.openOrFocusGallery();
  assert.equal(first, 42);
  assert.equal(storage.get('imagegrab:galleryTabId'), 42, '应把标签页 id 记录下来');

  const created = calls.filter((c) => c[0] === 'tabs.create').length;
  assert.equal(created, 1);

  const second = await mod.openOrFocusGallery();
  assert.equal(second, 42, '第二次应复用同一个标签页');
  assert.equal(calls.filter((c) => c[0] === 'tabs.create').length, 1, '不应重复新建标签页');
  assert.equal(calls.some((c) => c[0] === 'tabs.update'), true, '应聚焦已有标签页');
  const refreshed = calls.some((c) => c[0] === 'tabs.sendMessage' && c[2] && c[2].type === 'IMAGE_GRAB_REFRESH');
  assert.equal(refreshed, true, '应通知已有页面刷新');
});

test('标签页已被关闭时回退为新建', async () => {
  const { mod, calls } = await loadBackground({ tabAlive: false });
  // 先塞一个「已经不存在的」标签页 id
  await mod.openOrFocusGallery();
  const createdCount = calls.filter((c) => c[0] === 'tabs.create').length;
  assert.equal(createdCount, 1, 'tabs.get 失败后应新建标签页');
});

// ===== 提取结果处理 =====

test('handleGrabResult 落库并打开图片库', async () => {
  const { mod, storage } = await loadBackground();
  const res = await mod.handleGrabResult({
    images: [{ url: 'https://img.example.com/a.jpg', width: 800, height: 800 }],
    pageUrl: 'https://item.taobao.com/item.htm?id=1',
    pageTitle: '测试商品',
    host: 'item.taobao.com'
  });
  assert.equal(res.count, 1, '应返回图片数量');
  const saved = storage.get('imagegrab:lastResult');
  assert.equal(saved.images.length, 1);
  assert.equal(saved.host, 'item.taobao.com');
  assert.equal(storage.get('imagegrab:galleryTabId'), 42, '应打开图片库');
});

// ===== 消息路由 =====

test('消息路由能返回已保存的提取结果', async () => {
  const { mod, listeners, storage } = await loadBackground();
  storage.set('imagegrab:lastResult', { images: [{ url: 'x' }], host: 'h' });

  const handler = listeners.message[0];
  assert.equal(typeof handler, 'function', '应注册了 onMessage 监听');

  const resp = await new Promise((resolve) => {
    const asyncUsed = handler({ type: 'IMAGE_GRAB_GET_RESULT' }, {}, resolve);
    assert.equal(asyncUsed, true, '异步消息应返回 true 保持通道打开');
  });
  assert.equal(resp.ok, true);
  assert.equal(resp.result.images.length, 1);
});

test('未知消息类型不返回 true（不占用消息通道）', async () => {
  const { listeners } = await loadBackground();
  const handler = listeners.message[0];
  const ret = handler({ type: 'SOMETHING_ELSE' }, {}, () => {});
  assert.notEqual(ret, true);
});
