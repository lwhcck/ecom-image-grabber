/**
 * 用「真实页面里抓到的图片 URL」检验插件的 URL 过滤规则
 *
 * 数据来源：tools/verify_live_sites.py 抓取的真实淘宝 / 天猫 / 京东页面 HTML
 * （见 tools/fixtures/real-image-urls.json）。
 *
 * 重要说明（不要把结论说过头）：
 *   - 这些样本全部来自**首页**，不是商品详情页，所以它们是「首页装饰图 / 图标」，
 *     而不是商品图。因此本测试**不能**证明「真实商品图不会被误杀」。
 *   - 样本里没有小尺寸图标 URL（首页大图都是 1040×384、604×64 这种规格），
 *     所以「尺寸过滤」这一条在这里没有被覆盖，另行用真实尺寸探测（new Image）覆盖。
 *   - 本测试真正能证明的是两件事：
 *       1) 这些真实 URL 不会被 URL 关键词黑名单误杀；
 *       2) 真实图片 CDN 域名确实在 manifest 的 host_permissions 覆盖范围内。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_JS = path.join(HERE, '..', 'plugin', 'content.js');
const FIXTURE = path.join(HERE, 'fixtures', 'real-image-urls.json');

/** 在最小 DOM 环境里加载 content.js，取出它导出的真实函数 */
async function loadPlugin() {
  const mkEl = () => ({
    id: '', className: '', textContent: '', innerHTML: '',
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {},
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    remove() {}, dispatchEvent() {}
  });
  globalThis.window = {
    location: {
      href: 'https://item.taobao.com/item.htm?id=1', hostname: 'item.taobao.com',
      pathname: '/item.htm', search: '?id=1', scrollX: 0, scrollY: 0
    },
    addEventListener() {}, innerWidth: 1280, innerHeight: 800, scrollTo() {}
  };
  globalThis.location = globalThis.window.location;
  globalThis.document = {
    readyState: 'complete', documentElement: mkEl(), body: mkEl(), head: mkEl(), title: '',
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: mkEl, addEventListener() {}, styleSheets: []
  };
  globalThis.getComputedStyle = () => ({ backgroundImage: 'none', display: 'block' });
  globalThis.Image = class { set src(_) {} };
  globalThis.chrome = {
    runtime: { sendMessage() {}, getURL: (p) => p, lastError: null, onMessage: { addListener() {} } }
  };
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};

  const mod = await import(pathToFileURL(CONTENT_JS).href + '?t=' + Date.now());
  const t = globalThis.window.__IMAGEGRAB_TEST__;
  assert.ok(t, 'content.js 应当导出 __IMAGEGRAB_TEST__');
  return t;
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('真实 CDN 图片 URL 不会被 URL 关键词黑名单误杀', async () => {
  const t = await loadPlugin();
  const dropped = fixture.urls.filter((x) => !t.isUsableUrl(x.url));

  console.log(`\n  真实样本 ${fixture.urls.length} 条，被 URL 规则过滤掉 ${dropped.length} 条`);
  fixture.urls.slice(0, 5).forEach((x) => console.log('     通过  ' + x.url.slice(0, 100)));
  dropped.slice(0, 5).forEach((x) => console.log('     过滤  ' + x.url.slice(0, 100)));

  assert.equal(dropped.length, 0,
    '真实 CDN 图片 URL 被 URL 规则误杀：\n' + dropped.map((x) => '  ' + x.url).join('\n'));
});

test('URL 里的尺寸标记太大时不会被 URL 规则拦下（需靠真实尺寸校验兜底）', async () => {
  const t = await loadPlugin();

  // 淘宝图片 URL 会把尺寸写在文件名里，例如 tps-1040-384.png / tps-604-64.png
  const cases = [
    { url: 'https://img.alicdn.com/imgextra/i2/x_!!6000000001473-2-tps-1040-384.png', expect: true,
      why: '1040×384，URL 规则不该拦，交给真实尺寸校验' },
    { url: 'https://img.alicdn.com/imgextra/i1/x_!!6000000002899-2-tps-669-64.png', expect: true,
      why: '669×64，URL 规则只看 ≤90 的尺寸标记，这种「高 64」的需要真实尺寸校验兜底' },
    { url: 'https://img.alicdn.com/imgextra/i1/x_50x50.jpg', expect: false,
      why: '50×50，URL 规则应当直接拦掉' },
    { url: 'https://img.alicdn.com/imgextra/i1/logo_icon.png', expect: false,
      why: '含 logo/icon 关键词，URL 规则应当拦掉' }
  ];

  for (const c of cases) {
    const got = t.isUsableUrl(c.url);
    console.log(`  ${got === c.expect ? 'PASS' : 'FAIL'}  ${c.url.slice(-46)}  期望=${c.expect} 实际=${got}  （${c.why}）`);
    assert.equal(got, c.expect, c.why + '：' + c.url);
  }
});

test('真实图片 CDN 域名都在 manifest 的 host_permissions 覆盖范围内', async () => {
  const mf = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'plugin', 'manifest.json'), 'utf8'));

  /** 把 host_permissions 模式转成正则（* 只匹配域名片段） */
  const toRe = (pattern) => {
    const core = pattern.replace(/^\*:\/\//, '').replace(/\/\*$/, '');
    const escaped = core.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp('^' + escaped + '$', 'i');
  };
  const res = mf.host_permissions.map(toRe);

  const missing = [];
  for (const host of fixture.image_hosts) {
    const ok = res.some((re) => re.test(host));
    console.log(`  ${ok ? 'OK  ' : 'MISS'} ${host}`);
    if (!ok) missing.push(host);
  }
  assert.equal(missing.length, 0,
    '这些真实图片域名不在 host_permissions 里，抓图会失败：' + missing.join(', '));
});
