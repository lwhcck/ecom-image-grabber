/**
 * 交付物一致性审计
 *
 * 回答一个很容易出问题、但前面几十项检查都没覆盖的问题：
 * 「文档里提到的文件、脚本命令、截图，是不是真的都存在？」
 *
 * 检查内容：
 *   1. Markdown 里所有相对路径链接 / 反引号里的文件路径是否真实存在；
 *   2. package.json 里声明的脚本，对应的脚本文件是否存在；
 *   3. 文档里引用的工具脚本是否存在；
 *   4. 文档里写到的截图文件名是否都存在。
 *
 * 用法：node tools/audit-deliverables.mjs <作业三目录> <作业四目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A3 = path.resolve(process.argv[2] || path.join(HERE, '..'));
const A4 = process.argv[3] ? path.resolve(process.argv[3]) : null;

const problems = [];
const debugPaths = [];
const stats = { files: 0, links: 0, scripts: 0, shots: 0 };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function report(kind, file, detail) {
  problems.push({ kind, file: path.relative(process.cwd(), file), detail });
}

/** 在多个仓库根目录下按相对路径或文件名找文件 */
function existsAnywhere(rel, roots) {
  for (const root of roots.filter(Boolean)) {
    if (fs.existsSync(path.resolve(root, rel))) return true;
  }
  return false;
}

/** 全仓库按文件名递归查找（用于「文档只写了文件名」的情况） */
const basenameCache = new Map();
function findByBasename(name, roots) {
  const key = roots.join('|');
  if (!basenameCache.has(key)) {
    const all = new Map();
    for (const root of roots.filter(Boolean)) {
      for (const f of walk(root)) all.set(path.basename(f), f);
    }
    basenameCache.set(key, all);
  }
  return basenameCache.get(key).get(name) || null;
}

/** 检查一个 Markdown 文件里的路径引用 */
function checkMarkdown(mdPath, roots) {
  const text = fs.readFileSync(mdPath, 'utf8');
  const dir = path.dirname(mdPath);
  stats.files++;

  // 0) 先把这个文件里所有「裸文件名」链接的目标解析出来，后面反引号判断时复用，
  //    避免把「截图/xxx.png」这种只写了文件名的引用误判成断链
  const nameLinks = new Map();
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const target = m[2].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = decodeURIComponent(target.split('#')[0]);
    if (!clean) continue;
    stats.links++;
    // 依次尝试：文档同级 → 各仓库根 → 同仓库内同名文件
    const candidates = [path.resolve(dir, clean)];
    for (const r of roots.filter(Boolean)) candidates.push(path.resolve(r, clean));
    const byName = findByBasename(path.basename(clean), roots);
    if (byName) candidates.push(byName);
    if (!candidates.some((c) => fs.existsSync(c))) {
      report('断链', mdPath, `[${m[1]}](${target}) 找不到对应文件`);
    } else {
      nameLinks.set(path.basename(clean), true);
    }
  }

  // 1) 反引号里的项目内路径
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    if (/^(https?:|git |npm |node |pwsh |python |cd |curl |chrome|edge)/.test(raw)) continue;
    if (/[<>*?|]/.test(raw)) continue;              // 含通配符或占位符
    if (/\s/.test(raw) && !/\.(png|md)$/.test(raw)) continue;
    const looksLikePath = /^(?:[\w\u4e00-\u9fa5.\-]+\/)+[\w\u4e00-\u9fa5.\-]+$/.test(raw)
      || /\.(md|js|mjs|json|html|css|py|ps1|png|svg|zip|toml|txt)$/.test(raw);
    if (!looksLikePath) continue;
    // 只关注项目目录内的路径
    if (!/^(tools|plugin|public|src|docs|site|04_|03_|05_|02_|01_)\//.test(raw)) continue;

    stats.links++;
    debugPaths.push(`${path.basename(mdPath)} → ${raw}`);
    if (existsAnywhere(raw, roots)) continue;
    // 只写了文件名（没有目录前缀）时，允许在仓库里按同名文件兜底；
    // 写了目录前缀却找不到，就是真问题，不再用同名文件掩盖
    const hasDir = raw.includes('/');
    if (!hasDir) {
      if (nameLinks.has(path.basename(raw))) continue;
      if (findByBasename(path.basename(raw), roots)) continue;
    }
    report('可疑路径', mdPath, `\`${raw}\` 在各仓库根下都找不到`);
  }
}

// 临时调试：打印所有被当作「项目内路径」处理的反引号内容（设 AUDIT_DEBUG=1 时启用）
if (process.env.AUDIT_DEBUG === '1') {
  debugPaths.forEach((d) => console.log('  [debug] 路径候选: ' + d));
}

/** 检查 package.json 的脚本是否可执行（对应文件存在） */
function checkScripts(pkgPath, root) {
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    stats.scripts++;
    // 提取形如 node xxx / python xxx / pwsh ... xxx.ps1 里的脚本路径
    const m = cmd.match(/\b(?:node|python)\s+([^\s&|]+\.(?:mjs|js|py))/)
      || cmd.match(/-File\s+([^\s&|]+\.ps1)/);
    if (!m) continue;
    const rel = m[1].replace(/^["']|["']$/g, '');
    const resolved = path.resolve(root, rel);
    if (!fs.existsSync(resolved)) {
      report('脚本缺失', pkgPath, `npm run ${name} 引用的 ${rel} 不存在`);
    }
  }
}

/** 检查文档里提到的截图文件是否都存在 */
function checkShots(dir, docs, roots) {
  const shotsDir = path.join(dir, '04_提交材料', '截图');
  const listed = fs.existsSync(shotsDir) ? new Set(fs.readdirSync(shotsDir)) : new Set();
  for (const md of docs) {
    const text = fs.readFileSync(md, 'utf8');
    for (const m of text.matchAll(/([0-9A-Za-z_\u4e00-\u9fa5\-]+\.png)/g)) {
      const name = m[1];
      // 只检查「看起来像截图文件名」的引用：排除文档里描述「生成的文件名规则」的情况
      if (!/^(\d{2}|live_|health_)/.test(name)) continue;
      stats.shots++;
      const found = listed.has(name) || !!findByBasename(name, roots);
      if (!found) {
        report('截图缺失', md, `文档提到 ${name}，但仓库里找不到这个文件`);
      }
    }
  }
}

// ---------- 执行 ----------
console.log('交付物一致性审计');
console.log('  作业三：' + A3);
if (A4) console.log('  作业四：' + A4);

const mdFiles = [];
for (const root of [A3, A4].filter(Boolean)) {
  walk(root).filter((f) => f.endsWith('.md')).forEach((f) => mdFiles.push(f));
}
console.log(`\n扫描到 ${mdFiles.length} 个 Markdown 文件\n`);

const ROOTS = [A3, A4].filter(Boolean);

for (const md of mdFiles) {
  if (md.includes(path.join('04_提交材料', '提交材料_文档截图'))) continue; // 生成物，跳过
  checkMarkdown(md, ROOTS);
}

checkScripts(path.join(A3, 'package.json'), A3);
if (A4) checkScripts(path.join(A4, 'package.json'), A4);

checkShots(A3, mdFiles.filter((f) => f.startsWith(A3)), ROOTS);
if (A4) checkShots(A4, mdFiles.filter((f) => f.startsWith(A4)), ROOTS);

// ---------- 汇总 ----------
console.log(`检查统计：Markdown ${stats.files} 个，路径引用 ${stats.links} 处，npm 脚本 ${stats.scripts} 个，截图引用 ${stats.shots} 处`);
if (problems.length === 0) {
  console.log('\n结论：全部引用都能对应到真实存在的文件 ✓');
} else {
  console.log(`\n发现 ${problems.length} 处问题：`);
  problems.forEach((p) => console.log(`  [${p.kind}] ${p.file}\n      ${p.detail}`));
}
process.exit(problems.length === 0 ? 0 : 1);
