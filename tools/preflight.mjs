#!/usr/bin/env node
/**
 * 作业三 / 作业四 提交前自检（preflight）
 *
 * 目的：把「推送/部署之前能离线发现的问题」一次性查出来，避免交上去才发现漏文件、链接断了、
 *       权限申请过多、构建产物不对。
 *
 * 用法：
 *   node tools/preflight.mjs                    # 默认检查本仓库（作业三）
 *   node tools/preflight.mjs <作业三目录> <作业四目录>   # 同时检查两份作业
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A3 = path.resolve(process.argv[2] || path.join(HERE, '..'));
const A4 = process.argv[3] ? path.resolve(process.argv[3]) : null;

const results = [];
let currentGroup = '';

/** 开始一个检查分组 */
function group(title) {
  currentGroup = title;
  console.log('\n' + title);
}

/** 记录一条检查项 */
function check(name, ok, detail = '') {
  results.push({ group: currentGroup, name, ok: !!ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${ok || !detail ? '' : '  → ' + detail}`);
}

/** 安全读取文本 */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** 安全解析 JSON */
function readJson(p) {
  const t = readText(p);
  if (t == null) return { ok: false, error: '文件不存在' };
  try { return { ok: true, value: JSON.parse(t) }; }
  catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }
}

function exists(p) { return fs.existsSync(p); }

// =====================================================================
// 作业三
// =====================================================================
function checkA3() {
  console.log('='.repeat(62));
  console.log('作业三 · 电商图片下载插件 + GitHub Pages 官网');
  console.log('='.repeat(62));

  // ---------- 插件清单 ----------
  group('① 插件 manifest.json');
  const mfPath = path.join(A3, 'plugin', 'manifest.json');
  const mf = readJson(mfPath);
  check('manifest.json 存在且是合法 JSON', mf.ok, mf.error || '');
  if (mf.ok) {
    const m = mf.value;
    check('manifest_version 为 3（Manifest V3）', m.manifest_version === 3, String(m.manifest_version));
    check('声明了 name 与 version', !!m.name && !!m.version, `${m.name} / ${m.version}`);
    check('注入了 content_scripts', Array.isArray(m.content_scripts) && m.content_scripts.length > 0);
    check('配置了 background.service_worker', !!(m.background && m.background.service_worker),
      m.background ? String(m.background.service_worker) : '缺 background');

    // background.js 用了 ESM 语法（import/export），manifest 必须声明 type: module，
    // 否则 Chrome 按 classic worker 解析，直接语法错误 → Service Worker 起不来。
    if (m.background && m.background.service_worker) {
      const swPath = path.join(A3, 'plugin', m.background.service_worker);
      const swSrc = readText(swPath) || '';
      const usesEsm = /^\s*(import|export)\s/m.test(swSrc);
      const declaredModule = m.background.type === 'module';
      check('Service Worker 用 ESM 语法时 manifest 声明了 type: module',
        !usesEsm || declaredModule,
        usesEsm && !declaredModule
          ? `${m.background.service_worker} 里有 import/export，但 background.type 不是 "module"（Chrome 会按 classic worker 解析并报语法错误）`
          : `ESM=${usesEsm} type=${m.background.type || '(未设置)'}`);
    }

    // 权限最小化：不能出现 <all_urls>、tabs 之类过宽的申请
    const perms = Array.isArray(m.permissions) ? m.permissions : [];
    const hosts = Array.isArray(m.host_permissions) ? m.host_permissions : [];
    const expectedPerms = ['activeTab', 'scripting', 'downloads', 'storage'];
    const missing = expectedPerms.filter((p) => !perms.includes(p));
    check('包含必需权限（activeTab/scripting/downloads/storage）', missing.length === 0,
      missing.length ? '缺 ' + missing.join(', ') : '');
    const badPerms = perms.filter((p) => ['<all_urls>', 'tabs', 'webRequest', 'cookies', 'history'].includes(p));
    check('没有申请过宽的权限', badPerms.length === 0, badPerms.join(', '));

    // host_permissions 允许三类：
    //   1) 三个平台的站点域名
    //   2) 这些平台的图片 CDN（商品图实际托管在 CDN 上，Service Worker fetch 需要权限）
    //   3) 绝不允许 <all_urls>
    // 注意 TLD 不都是 .com（淘宝的 tbcdn.cn 是 .cn），所以只约束域名主体
    const PLATFORM_HOSTS = /^(\*:\/\/)?\*\.(taobao|tmall|jd|pinduoduo|yangkeduo)\.[a-z.]+\/\*$/;
    const CDN_HOSTS = /^(\*:\/\/)?\*\.(alicdn|tbcdn|360buyimg|pddpic)\.[a-z.]+\/\*$/;
    check('host_permissions 只覆盖平台站点或平台图片 CDN',
      hosts.length > 0 && hosts.every((h) => PLATFORM_HOSTS.test(h) || CDN_HOSTS.test(h)),
      hosts.filter((h) => !PLATFORM_HOSTS.test(h) && !CDN_HOSTS.test(h)).join(' '));
    check('host_permissions 覆盖了平台图片 CDN（否则跨域抓图会失败）',
      hosts.some((h) => CDN_HOSTS.test(h)), '缺 CDN 域名');
    check('没有申请 <all_urls> 主机权限', !hosts.includes('<all_urls>'));

    // 清单里引用的文件都要真实存在
    const referenced = [];
    if (m.background && m.background.service_worker) referenced.push(m.background.service_worker);
    (m.content_scripts || []).forEach((cs) => {
      (cs.js || []).forEach((f) => referenced.push(f));
      (cs.css || []).forEach((f) => referenced.push(f));
    });
    Object.values(m.icons || {}).forEach((f) => referenced.push(f));
    if (m.action && m.action.default_icon) Object.values(m.action.default_icon).forEach((f) => referenced.push(f));
    (m.web_accessible_resources || []).forEach((war) => (war.resources || []).forEach((f) => {
      if (!f.includes('*')) referenced.push(f);
    }));

    const missingFiles = referenced.filter((f) => !exists(path.join(A3, 'plugin', f)));
    check(`manifest 引用的 ${referenced.length} 个文件都存在`, missingFiles.length === 0,
      missingFiles.length ? '缺 ' + missingFiles.join(', ') : '');
  }

  // ---------- 插件源码 ----------
  group('② 插件源码完整性');
  const pluginFiles = ['content.js', 'content.css', 'background.js', 'gallery.html', 'gallery.js', 'gallery.css'];
  const missPlugin = pluginFiles.filter((f) => !exists(path.join(A3, 'plugin', f)));
  check('核心文件齐全（6 个）', missPlugin.length === 0, missPlugin.join(', '));

  check('图标 PNG 头合法（16/32/48/128）',
    [16, 32, 48, 128].every((s) => {
      const p = path.join(A3, 'plugin', 'icons', `icon${s}.png`);
      const buf = fs.existsSync(p) ? fs.readFileSync(p) : null;
      return buf && buf.length > 100 && buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG';
    }));

  const contentJs = readText(path.join(A3, 'plugin', 'content.js')) || '';
  check('content.js 覆盖三个平台的域名匹配', /taobao\.com/.test(contentJs) && /jd\.com/.test(contentJs)
    && /pinduoduo\.com/.test(contentJs));
  check('content.js 兼容懒加载属性（data-src / data-lazy-src）',
    /data-src/.test(contentJs) && /data-lazy-src/.test(contentJs));
  check('content.js 有尺寸过滤阈值 MIN_SIZE', /MIN_SIZE/.test(contentJs));

  // 详情页判定不能只看域名：淘宝首页和详情页是同一个域名（item.taobao.com），
  // 只看域名会把首页也判成详情页并注入按钮（该 bug 由真机验证抓出过）。
  check('详情页判定不使用域名（只认路径 / DOM 特征）',
    !/hostname\s*\)?\s*\)?\s*\)\s*test|DETAIL_URL_PATTERNS/.test(contentJs)
    && /DETAIL_PATH_HINTS/.test(contentJs),
    'content.js 里不应存在按域名判断详情页的逻辑');

  const bgJs = readText(path.join(A3, 'plugin', 'background.js')) || '';
  check('background.js 用 OffscreenCanvas 转 PNG', /OffscreenCanvas/.test(bgJs));
  check('background.js 调用 chrome.downloads.download', /downloads\.download/.test(bgJs));

  // 去掉注释后再判断，避免把注释里的说明文字当成真实调用
  const bgCode = bgJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('background.js 未使用需要 tabs 权限的 chrome.tabs.query', !/chrome\.tabs\.query/.test(bgCode));

  const galleryHtml = readText(path.join(A3, 'plugin', 'gallery.html')) || '';
  check('gallery.html 引用了 gallery.js 与 gallery.css',
    galleryHtml.includes('gallery.js') && galleryHtml.includes('gallery.css'));

  // ---------- 官网 / GitHub Pages ----------
  group('③ 官网与 GitHub Pages 发布目录');
  const docsHtml = readText(path.join(A3, 'docs', 'index.html'));
  check('docs/index.html 存在（Pages 发布目录）', docsHtml != null);
  check('docs/index.html 是完整 HTML', !!docsHtml && /<!DOCTYPE html>/i.test(docsHtml) && /<\/html>/i.test(docsHtml));
  check('docs/.nojekyll 存在（避免 Jekyll 处理下划线文件）', exists(path.join(A3, 'docs', '.nojekyll')));

  const siteAssets = ['css/style.css', 'js/main.js'];
  const missSite = siteAssets.filter((f) => !exists(path.join(A3, 'docs', f)));
  check('docs 下静态资源齐全（css/js）', missSite.length === 0, missSite.join(', '));
  check('官网首页链接的资源都存在',
    !!docsHtml && ['css/style.css', 'js/main.js'].every((f) => docsHtml.includes(f)));

  // site/ 与 docs/ 是否同步（内容一致）
  const same = (a, b) => {
    const x = readText(path.join(A3, a)); const y = readText(path.join(A3, b));
    return x != null && x === y;
  };
  check('site/ 与 docs/ 内容同步（index.html）', same('site/index.html', 'docs/index.html'));
  check('site/ 与 docs/ 内容同步（css、js）',
    same('site/css/style.css', 'docs/css/style.css') && same('site/js/main.js', 'docs/js/main.js'));

  check('官网引用了真实存在的图片资源（无外链）',
    !!docsHtml && !/https?:\/\/(?!github\.com)[^"']*\.(png|jpg|jpeg|webp|svg)/i.test(docsHtml.replace(/https:\/\/github\.com[^"']*/g, '')));

  // ---------- 测试素材与取证 ----------
  group('④ 测试素材与取证材料');
  const assets = ['demo_img_01.png', 'demo_img_02.png', 'demo_img_03.png', 'demo_img_04.png', 'demo_img_05.png', 'demo_img_small_20.png'];
  const missAssets = assets.filter((f) => !exists(path.join(A3, '05_测试素材', f)));
  check('演示素材完整（含 1 张应被过滤的小图）', missAssets.length === 0, missAssets.join(', '));
  check('演示详情页存在', exists(path.join(A3, '03_本地测试', '演示商品详情页.html')));
  check('取证页存在（capture.html / gallery-mock.html）',
    exists(path.join(A3, '03_本地测试', '插件取证', 'capture.html'))
    && exists(path.join(A3, '03_本地测试', '插件取证', 'gallery-mock.html')));

  // ---------- 提交材料 ----------
  group('⑤ 提交材料');
  const shots = [
    '03_插件运行截图.png', '03B_提取逻辑实测.png', '04_推送到GitHub截图.png',
    '06_GitHubPages官网截图.png', '06B_官网_手机375.png'
  ];
  const missShots = shots.filter((f) => !exists(path.join(A3, '04_提交材料', '截图', f)));
  check(`${shots.length} 张提交截图齐全`, missShots.length === 0, missShots.join(', '));
  check('域名地址记录文件存在', exists(path.join(A3, '04_提交材料', '域名地址.txt')));
  check('提交说明存在（README.md）', exists(path.join(A3, 'README.md')));
  check('开发过程材料存在（三轮 Prompt）', exists(path.join(A3, '02_开发过程', '插件开发过程与三轮Prompt.md')));

  // ---------- git 仓库 ----------
  group('⑥ git 仓库状态');
  check('.git 目录存在（已初始化仓库）', exists(path.join(A3, '.git')));
  check('.gitignore 存在且忽略 __pycache__', (readText(path.join(A3, '.gitignore')) || '').includes('__pycache__'));
}

// =====================================================================
// 作业四
// =====================================================================
function checkA4() {
  console.log('\n' + '='.repeat(62));
  console.log('作业四 · 个人网站（PRD / TECH_DESIGN / AGENTS + Cloudflare Pages）');
  console.log('='.repeat(62));

  // ---------- 三份文档 ----------
  group('① 三份文档');
  const docs = [
    ['PRD.md', ['产品需求', '验收标准']],
    ['TECH_DESIGN.md', ['架构', '接口', '鉴权', '存储']],
    ['AGENTS.md', ['禁止', '编码规范', '验证']]
  ];
  docs.forEach(([file, keywords]) => {
    const text = readText(path.join(A4, file));
    check(`${file} 存在且有实质内容（> 2000 字符）`, !!text && text.length > 2000,
      text ? text.length + ' 字符' : '文件不存在');
    if (text) {
      const miss = keywords.filter((k) => !text.includes(k));
      check(`${file} 覆盖关键章节（${keywords.join('/')}）`, miss.length === 0, miss.join(', '));
    }
  });

  // ---------- 后端 ----------
  group('② 后端 _worker.js');
  const workerPath = path.join(A4, 'src', '_worker.js');
  const worker = readText(workerPath);
  check('src/_worker.js 存在', worker != null);
  if (worker) {
    check('导出了 onRequest（Pages Functions 模块形式）', /export\s+async\s+function\s+onRequest/.test(worker));
    check('导出了 default（wrangler / Service Worker 形式）', /export\s+default\s*\{/.test(worker));
    const routes = ['/api/profile', '/api/login', '/api/logout', '/api/reset', '/api/health'];
    const missRoutes = routes.filter((r) => !worker.includes(r));
    check(`${routes.length} 个接口路由都在`, missRoutes.length === 0, missRoutes.join(', '));
    check('密码用 PBKDF2 哈希校验', /PBKDF2/.test(worker) && /deriveBits/.test(worker));
    check('会话用 HMAC 签名', /HMAC/.test(worker) && /sign/.test(worker));
    check('Cookie 带 HttpOnly 与 SameSite', /HttpOnly/.test(worker) && /SameSite=Strict/.test(worker));
    check('写接口有服务端字段校验', /validateProfile/.test(worker));
    check('存储不可用时返回 503（不谎报成功）', /503/.test(worker));
    check('自检只返回布尔、不回密钥内容',
      /healthOf/.test(worker) && !/health[^}]*passwordHash\s*:/.test(worker.replace(/\s+/g, '')));
  }

  // ---------- 前端与字段一致性 ----------
  group('③ 前端与后台表单一致性');
  const html = readText(path.join(A4, 'public', 'index.html'));
  const siteJs = readText(path.join(A4, 'public', 'site.js'));
  check('public/index.html 存在', html != null);
  check('public/site.js 存在', siteJs != null);

  if (html && siteJs) {
    // site.js 里用 getElementById 取的所有 id，HTML 里都要有
    const ids = [...siteJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    const uniqIds = [...new Set(ids)];
    const missIds = uniqIds.filter((id) => !html.includes(`id="${id}"`));
    check(`site.js 引用的 ${uniqIds.length} 个元素 id 在 HTML 中都存在`, missIds.length === 0,
      missIds.length ? '缺 ' + missIds.join(', ') : '');

    // HTML 里每个 input/textarea 都要有对应 label
    const inputs = [...html.matchAll(/<(?:input|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    const noLabel = inputs.filter((id) => !html.includes(`for="${id}"`));
    check(`表单 ${inputs.length} 个输入控件都有 label 关联（无障碍）`, noLabel.length === 0,
      noLabel.length ? '缺 label: ' + noLabel.join(', ') : '');

    // data-field 标记：展示区与渲染逻辑要对得上
    const dataFields = [...html.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]);
    check('展示区有 data-field 标记（供渲染）', dataFields.length > 0, `${dataFields.length} 个`);

    // 禁止用 innerHTML 渲染内容数据（只看真实代码，忽略注释里提到的字样）
    const codeOnly = siteJs
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 去掉块注释
      .replace(/\/\/[^\n]*/g, '');         // 去掉行注释
    const innerHtmlUses = [...codeOnly.matchAll(/innerHTML/g)].length;
    check('site.js 未用 innerHTML 渲染数据（防 XSS）', innerHtmlUses === 0, `出现 ${innerHtmlUses} 次`);

    // hidden 属性会被 CSS 的 display 覆盖（曾经真的踩过：未登录时编辑表单也显示出来）。
    // 因此：凡是「带 hidden 属性的元素」用的 class，一旦在 CSS 里设置了 display，
    // 就必须同时提供 .class[hidden]{display:none} 兜底。
    const css = readText(path.join(A4, 'public', 'style.css')) || '';
    const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');

    /** 收集某个 class 上所有声明了 display 的规则（含复合选择器） */
    const displayRulesOfClass = (cls) => {
      const re = new RegExp('(?:^|[},])\\s*([^{},]*\\.' + cls + '(?![\\w-])[^{}]*)\\{([^}]*)\\}', 'gm');
      const out = [];
      for (const m of cssNoComment.matchAll(re)) {
        const d = (m[2] || '').match(/display\s*:\s*([^;\s]+)/);
        if (d) out.push(m[1].trim().slice(0, 60) + ' → display:' + d[1]);
      }
      return out;
    };

    // 只匹配真正的 hidden 属性，不能把 aria-hidden="true" 也算进来
    const hiddenTags = [...html.matchAll(/<[^>]*\shidden(?=[\s/>])[^>]*>/g)].map((m) => m[0]);
    const hiddenClasses = new Set();
    hiddenTags.forEach((tag) => {
      const cm = tag.match(/class="([^"]+)"/);
      if (cm) cm[1].split(/\s+/).filter(Boolean).forEach((c) => hiddenClasses.add(c));
    });

    const offenders = [];
    hiddenClasses.forEach((cls) => {
      const rules = displayRulesOfClass(cls);
      if (!rules.some((r) => !/display:\s*none/.test(r))) return; // 没有非 none 的 display → hidden 照常生效
      const hasGuard = new RegExp('\\.' + cls + '\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none').test(css);
      if (!hasGuard) offenders.push('.' + cls + '（' + rules.join('；') + '）');
    });

    check(`带 hidden 的 ${hiddenClasses.size} 个 class 都有 [hidden]{display:none} 兜底`,
      offenders.length === 0,
      offenders.length ? '这些 class 设置了 display 却缺少兜底：' + offenders.join(' / ') : '');
  }

  // ---------- 内容与配置 ----------
  group('④ 内容与配置');
  const c1 = readJson(path.join(A4, 'content.json'));
  const c2 = readJson(path.join(A4, 'src', 'content.default.json'));
  const c3 = readJson(path.join(A4, 'public', 'content.json'));
  check('content.json 是合法 JSON', c1.ok, c1.error || '');
  check('src/content.default.json 是合法 JSON', c2.ok, c2.error || '');
  check('三份内容文件完全一致', c1.ok && c2.ok && c3.ok
    && JSON.stringify(c1.value) === JSON.stringify(c2.value)
    && JSON.stringify(c2.value) === JSON.stringify(c3.value));

  const pkg = readJson(path.join(A4, 'package.json'));
  check('package.json 是合法 JSON', pkg.ok, pkg.error || '');
  if (pkg.ok) {
    const s = pkg.value.scripts || {};
    ['build', 'dev', 'test', 'deploy'].forEach((k) => check(`package.json 有 ${k} 脚本`, !!s[k]));
  }

  const wrangler = readText(path.join(A4, 'wrangler.toml'));
  check('wrangler.toml 存在', wrangler != null);
  if (wrangler) {
    check('wrangler.toml 声明了 pages_build_output_dir', /pages_build_output_dir\s*=/.test(wrangler));
    check('wrangler.toml 里没有明文密钥',
      !/ADMIN_PASSWORD_HASH\s*=\s*["'][^"']+["']/.test(wrangler)
      && !/SESSION_SECRET\s*=\s*["'][^"']+["']/.test(wrangler));
  }

  // ---------- 构建产物 ----------
  group('⑤ 构建产物 dist/');
  const distFiles = ['index.html', 'style.css', 'site.js', 'favicon.svg', '_worker.js', 'content.json'];
  const missDist = distFiles.filter((f) => !exists(path.join(A4, 'dist', f)));
  check(`dist/ 产物齐全（${distFiles.length} 个）`, missDist.length === 0,
    missDist.length ? '缺 ' + missDist.join(', ') + '（先跑 npm run build）' : '');

  const srcW = readText(path.join(A4, 'src', '_worker.js'));
  const distW = readText(path.join(A4, 'dist', '_worker.js'));
  check('dist/_worker.js 与 src/_worker.js 一致（构建产物是最新的）', srcW != null && srcW === distW);
  const distHtml = readText(path.join(A4, 'dist', 'index.html'));
  check('dist/index.html 与 public/index.html 一致', distHtml != null && distHtml === html);

  // ---------- 提交材料 ----------
  group('⑥ 提交材料');
  const shots4 = [
    '01_首页_修改前.png', '02_后台_登录页.png', '03_后台_编辑中.png', '04_保存后首页_已生效.png',
    '03_A_PRD内容.png', '03_B_TECH_DESIGN内容.png', '03_C_AGENTS内容.png'
  ];
  const missShots4 = shots4.filter((f) => !exists(path.join(A4, '04_提交材料', '截图', f)));
  check(`${shots4.length} 张问卷截图齐全`, missShots4.length === 0, missShots4.join(', '));
  check('域名地址记录文件存在', exists(path.join(A4, '04_提交材料', '域名地址.txt')));
  check('部署步骤说明存在', exists(path.join(A4, '04_提交材料', '部署步骤.md')));
  check('提交说明存在', exists(path.join(A4, '04_提交材料', '提交说明.md')));
  check('README.md 存在', exists(path.join(A4, 'README.md')));

  // ---------- 文档截图是否过期（第 03 题交的是三份文档的截图）----------
  group('⑥·2 文档截图是否与源文档同步');
  const docMap = [
    ['PRD.md', 'PRD.html', '03_A_PRD内容.png'],
    ['TECH_DESIGN.md', 'TECH_DESIGN.html', '03_B_TECH_DESIGN内容.png'],
    ['AGENTS.md', 'AGENTS.html', '03_C_AGENTS内容.png']
  ];

  docMap.forEach(([md, html, png]) => {
    const mdPath = path.join(A4, md);
    const htmlPath = path.join(A4, '04_提交材料', '提交材料_文档截图', html);
    const pngPath = path.join(A4, '04_提交材料', '截图', png);
    const mdText = readText(mdPath);
    const htmlText = readText(htmlPath);
    if (mdText == null || htmlText == null) {
      check(`${md} 的截图页存在`, false, '缺少 HTML 截图页，先跑 node tools/verify-docs.mjs');
      return;
    }

    // 1) 源文档规模与截图页记录的规模是否一致（换行符无关，可精确复现）
    //    用文档自身的换行符统计行数，避免 CRLF/LF 差异造成误报
    const srcChars = mdText.length;
    const srcLines = mdText.split(/\r?\n/).length;
    const m = htmlText.match(/source-stats:\s*chars=(\d+)\s+lines=(\d+)/);
    if (!m) {
      check(`${md} 的截图页带有源规模标记`, false, '页面里没有 source-stats 标记，请重跑 node tools/verify-docs.mjs');
    } else {
      const okChars = Number(m[1]) === srcChars;
      const okLines = Number(m[2]) === srcLines;
      check(`${md} 的截图页内容是当前版本（源规模一致）`, okChars && okLines,
        `页面记录 ${m[1]} 字符/${m[2]} 行，当前文档 ${srcChars} 字符/${srcLines} 行`
        + '（文档改过就要重跑 node tools/verify-docs.mjs 并重拍截图）');
    }

    // 2) 文件时间：截图比源文档旧说明截图没重做
    if (exists(mdPath) && exists(pngPath)) {
      const mdTime = fs.statSync(mdPath).mtimeMs;
      const pngTime = fs.statSync(pngPath).mtimeMs;
      check(`${png} 不早于 ${md}`, pngTime >= mdTime,
        `截图 ${new Date(pngTime).toLocaleString('zh-CN')} 早于源文档 ${new Date(mdTime).toLocaleString('zh-CN')}`);
    }
  });

  // ---------- git 仓库 ----------
  group('⑦ git 仓库状态');
  check('.git 目录存在（已初始化仓库）', exists(path.join(A4, '.git')));
  const gi4 = readText(path.join(A4, '.gitignore')) || '';
  check('.gitignore 忽略 node_modules 与 dist', gi4.includes('node_modules') && gi4.includes('dist'));
  check('.gitignore 忽略 .dev.vars（防止密钥进仓库）', gi4.includes('.dev.vars') || gi4.includes('.env'));
  check('仓库里没有 .dev.vars / .env 明文密钥文件',
    !exists(path.join(A4, '.dev.vars')) && !exists(path.join(A4, '.env')));
}

// =====================================================================
// 运行
// =====================================================================
console.log('提交前自检（preflight）');
console.log('作业三：' + A3);
if (A4) console.log('作业四：' + A4);

if (exists(path.join(A3, 'plugin'))) checkA3();
else { check('定位作业三目录', false, A3 + ' 下没有 plugin/ 目录'); }

if (A4) {
  if (exists(path.join(A4, 'src', '_worker.js'))) checkA4();
  else { check('定位作业四目录', false, A4 + ' 下没有 src/_worker.js'); }
}

// ---------- 汇总 ----------
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log('\n' + '='.repeat(62));
console.log(`自检结果：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n需要修的问题：');
  results.filter((r) => !r.ok).forEach((r) => {
    console.log(`  • [${r.group}] ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
  });
}
console.log('='.repeat(62));
process.exit(fail === 0 ? 0 : 1);
