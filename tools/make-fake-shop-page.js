/**
 * 生成「本地伪装的电商详情页」（供真机验证 content.js 使用）
 *
 * 为什么需要它：content.js 只在支持的平台域名下注入按钮。本机没有真实电商账号，
 * 所以这里把 03_本地测试/演示商品详情页.html 复制成一个可被 host-resolver 映射到
 * item.taobao.com 的页面，让插件在真实浏览器里真的跑一遍。
 *
 * 用法：node tools/make-fake-shop-page.js <演示页.html> <素材目录> <输出目录>
 */
import fs from 'node:fs';
import path from 'node:path';

const demoHtmlPath = process.argv[2];
const assetDir = process.argv[3];
const outDir = process.argv[4];

if (!demoHtmlPath || !assetDir || !outDir) {
  console.error('用法: node tools/make-fake-shop-page.js <演示页.html> <素材目录> <输出目录>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

let html = fs.readFileSync(demoHtmlPath, 'utf8');

// 把 ../05_测试素材/xxx.png 改成 ./assets/xxx.png（输出目录里会放一份素材）
html = html.replace(/\.\.\/05_测试素材\//g, './assets/');

// 页面里那句「本页为 file:// 或 localhost，因此不会显示悬浮按钮」在伪装域名下不再成立，替换掉
html = html.replace(
  /插件按域名匹配注入按钮[\s\S]*?请在受支持域名的商品详情页测试。/,
  '本页由 tools/make-fake-shop-page.js 生成，通过 --host-resolver-rules 映射为 item.taobao.com，' +
  '因此插件的 content.js 会真实注入「获取图片」按钮，用于真机验证。'
);

// 确保有 assets 目录
const assetsOut = path.join(outDir, 'assets');
fs.mkdirSync(assetsOut, { recursive: true });
for (const f of fs.readdirSync(assetDir)) {
  if (f.toLowerCase().endsWith('.png')) {
    fs.copyFileSync(path.join(assetDir, f), path.join(assetsOut, f));
  }
}

fs.writeFileSync(path.join(outDir, 'item.htm'), html, 'utf8');
// 输出两份：/item.htm 贴近真实淘宝详情页地址，index.html 方便直接打开
fs.writeFileSync(path.join(outDir, 'item.htm'), html, 'utf8');
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

// 另外复制一份「首页」页面，用于验证「非详情页不注入按钮」
const homeSrc = path.join(path.dirname(demoHtmlPath), '模拟电商首页.html');
if (fs.existsSync(homeSrc)) {
  fs.copyFileSync(homeSrc, path.join(outDir, 'home.html'));
  console.log('已生成首页页面：' + path.join(outDir, 'home.html') + '（用于验证非详情页不注入按钮）');
} else {
  console.warn('未找到 模拟电商首页.html，跳过首页验证页生成');
}

const size = fs.statSync(path.join(outDir, 'index.html')).size;
console.log('已生成伪装的电商详情页：');
console.log('  ' + path.join(outDir, 'item.htm') + `（${size} 字节）`);
console.log('  ' + path.join(outDir, 'index.html') + '（同上，便于直接打开）');
console.log('  ' + path.join(assetsOut) + `（${fs.readdirSync(assetsOut).length} 张图）`);
console.log('访问方式：起本地服务后，用 --host-resolver-rules 把 item.taobao.com 指到 127.0.0.1');
