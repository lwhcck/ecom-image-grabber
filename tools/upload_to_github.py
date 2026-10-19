#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
作业三 · 一键上传到 GitHub 并开启 Pages

做四件事：
  1. 把本地 58 个文件（排除 __pycache__）按正确目录结构上传到 lwhcck/ecom-image-grabber
  2. 建立首次提交，写入 main 分支
  3. 开启 GitHub Pages（源目录 /docs）
  4. 逐项核对结果，并打印报告

需要的 Token 权限（Fine-grained token）：
  Repository: lwhcck/ecom-image-grabber
  Permissions: Contents = Read and write
                Pages    = Read and write      （仅当要脚本自动开 Pages 时）
如果 Token 没有 Pages 权限，脚本会跳过自动开 Pages，并提示你去网页点两下。

用法（在 PowerShell 里）：
  cd "C:\\Users\\lenovo\\Desktop\\实习\\作业三"
  python tools/upload_to_github.py

Token 不会写到任何文件里，只在本进程内存中使用。
"""

import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

# Windows 控制台默认可能是 GBK，直接 print 中文会抛 UnicodeEncodeError。
# 这里把输出流切成 UTF-8，并把无法编码的字符替换掉，保证脚本不会因为中文而崩。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

OWNER = 'lwhcck'
REPO = 'ecom-image-grabber'
BRANCH = 'main'
API = 'https://api.github.com'

# 要上传的内容（相对本脚本所在目录的上一级，即“作业三”）
INCLUDE = ['plugin', 'site', 'docs', 'tools', 'README.md', '.gitignore']
# 排除规则
EXCLUDE_DIRS = {'__pycache__', '.git', 'node_modules', 'dist'}
EXCLUDE_NAME_SUFFIX = ('.pyc',)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def log(msg=''):
    print(msg, flush=True)


def die(msg, hint=None):
    log('')
    log('✗ ' + msg)
    if hint:
        log('  → ' + hint)
    sys.exit(1)


# ---------------- 读取 Token ----------------
def get_token():
    """优先读环境变量；否则交互式提示输入。

    注意：非交互环境（stdin 被重定向）下不要调用 getpass，否则会卡住不返回，
    那种情况直接给出明确提示退出。
    """
    tok = (os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN') or '').strip()
    if tok:
        log('已从环境变量读取 Token（长度 %d）' % len(tok))
        return tok

    if not sys.stdin.isatty():
        die('没有检测到 Token，且当前不是交互式终端',
            '请先设置环境变量：$env:GITHUB_TOKEN="github_pat_..." 然后重新运行')

    log('没有检测到环境变量 GITHUB_TOKEN。')
    log('请粘贴 Token 后回车（输入时屏幕不会显示，粘贴完直接回车即可）：')
    try:
        import getpass
        tok = getpass.getpass('Token: ')
    except (ImportError, EOFError, KeyboardInterrupt):
        try:
            tok = input('Token: ')
        except (EOFError, KeyboardInterrupt):
            die('没有输入 Token')
    tok = (tok or '').strip()
    if not tok:
        die('没有输入 Token',
            '请重新运行；或先设置 $env:GITHUB_TOKEN="github_pat_..."')
    return tok


# ---------------- HTTP ----------------
def api(method, path, token, payload=None, ok_status=None):
    url = API + path
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    req.add_header('User-Agent', 'dsh-uploader')
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode('utf-8')
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {'raw': body[:400]}
        if ok_status and e.code in ok_status:
            return e.code, parsed
        return e.code, parsed
    except Exception as e:
        return 0, {'error': str(e)}


# ---------------- 兜底上传（Contents API） ----------------
def upload_via_contents_api(token, files):
    """兜底方案：逐个文件用 Contents API 写入。

    Contents API 对空仓库一定可用（网页上"创建文件"用的就是它）。
    代价是每个文件产生一次提交，历史不好看，但保证能传上去。
    """
    import urllib.parse
    ok = 0
    failed = []
    for i, (rel, full) in enumerate(files, 1):
        with open(full, 'rb') as f:
            content = f.read()
        path = urllib.parse.quote(rel)
        payload = {
            'message': '上传 %s' % rel,
            'content': base64.b64encode(content).decode('ascii'),
            'branch': BRANCH,
        }
        st, res = api('PUT', '/repos/%s/%s/contents/%s' % (OWNER, REPO, path), token, payload)

        # 文件已存在时 Contents API 返回 422，需要带上现有 sha 才能更新
        if st == 422:
            st_g, cur = api('GET', '/repos/%s/%s/contents/%s?ref=%s'
                            % (OWNER, REPO, path, BRANCH), token)
            if st_g == 200 and cur.get('sha'):
                payload['sha'] = cur['sha']
                st, res = api('PUT', '/repos/%s/%s/contents/%s' % (OWNER, REPO, path),
                              token, payload)

        if st in (200, 201):
            ok += 1
            if i % 10 == 0 or i == len(files):
                log('  兜底已写入 %d/%d' % (i, len(files)))
        else:
            msg = res.get('message') if isinstance(res, dict) else ''
            failed.append((rel, st, msg))
            if len(failed) <= 3:
                log('  ✗ %s 失败 (HTTP %s)  %s' % (rel, st, msg))
            if len(failed) >= 3:
                log('  兜底方案也连续失败，停止。')
                break
    return ok, failed


# ---------------- 收集文件 ----------------
def collect_files():
    files = []
    for item in INCLUDE:
        p = os.path.join(ROOT, item)
        if not os.path.exists(p):
            log('  跳过（不存在）: ' + item)
            continue
        if os.path.isfile(p):
            files.append((item.replace(os.sep, '/'), p))
            continue
        for dirpath, dirnames, filenames in os.walk(p):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in filenames:
                if fn.endswith(EXCLUDE_NAME_SUFFIX):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
                files.append((rel, full))
    files.sort(key=lambda x: x[0])
    return files


def blob_sha1(data):
    """Git blob 的哈希算法：sha1("blob <len>\\0" + content)"""
    h = hashlib.sha1()
    h.update(b'blob ' + str(len(data)).encode() + b'\x00')
    h.update(data)
    return h.hexdigest()


# 空文件的 blob 哈希（仅用于自检，实际仍必须通过接口创建该对象）
EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
assert blob_sha1(b'') == EMPTY_BLOB_SHA, '空 blob 哈希与预期不符，请检查算法'


def ensure_first_commit(token):
    """确保仓库至少有一个提交，返回 (commit_sha, tree_sha)。

    为什么需要这一步：
      GitHub 对「一个提交都没有」的空仓库，会拒绝 Git Data API 的写操作
      （POST /git/blobs 返回 409 Git Repository is empty）。
      所以空仓库要先通过 Contents API 建一个文件，让它产生第一个提交，
      之后的 blob/tree/commit 才能正常写入。
    """
    st, commits = api('GET', '/repos/%s/%s/commits?per_page=1' % (OWNER, REPO), token)
    if st == 200 and isinstance(commits, list) and commits:
        sha = commits[0]['sha']
        log('  仓库已有提交: %s' % sha[:10])
        st2, c = api('GET', '/repos/%s/%s/git/commits/%s' % (OWNER, REPO, sha), token)
        tree_sha = c.get('tree', {}).get('sha') if st2 == 200 else None
        if tree_sha:
            log('  现有目录树: %s' % tree_sha[:10])
        return sha, tree_sha

    # 走到这里说明仓库是空的（通常是 409 Git Repository is empty，或返回空数组）
    log('  仓库还没有任何提交，先建一个初始提交（否则后续写文件会被拒绝）')
    bootstrap = ('# ecom-image-grabber\n\n'
                 '电商图片提取下载插件（作业三）\n\n'
                 '本文件由初始化步骤临时创建，随后会被正式内容覆盖。\n')
    payload = {
        'message': '初始化仓库',
        'content': base64.b64encode(bootstrap.encode('utf-8')).decode('ascii'),
        'branch': BRANCH,
    }
    st3, res3 = api('PUT', '/repos/%s/%s/contents/README.md' % (OWNER, REPO), token, payload)
    if st3 not in (200, 201):
        msg = res3.get('message') if isinstance(res3, dict) else ''
        die('建立初始提交失败（HTTP %s）%s' % (st3, msg),
            '① 确认 Token 的 Contents 权限是 Read and write ② 仓库不能再是空的')
    init_commit = res3.get('commit', {}).get('sha')
    init_tree = res3.get('commit', {}).get('tree', {}).get('sha')
    log('  ✓ 初始提交已创建: %s' % (init_commit or '')[:10])
    if not init_tree:
        st4, c = api('GET', '/repos/%s/%s/git/commits/%s' % (OWNER, REPO, init_commit), token)
        init_tree = c.get('tree', {}).get('sha') if st4 == 200 else None
    return init_commit, init_tree


# ---------------- 主流程 ----------------
def main():
    log('=' * 58)
    log('作业三 · 上传到 GitHub')
    log('=' * 58)
    log('本地目录: ' + ROOT)
    log('目标仓库: %s/%s' % (OWNER, REPO))
    log()

    if not os.path.isdir(os.path.join(ROOT, 'plugin')):
        die('当前目录看起来不是“作业三”目录',
            '请先 cd 到 C:\\Users\\lenovo\\Desktop\\实习\\作业三 再运行')

    token = get_token()

    # --- 1. 验证 Token 与仓库 ---
    log('\n[1/5] 验证 Token 和仓库 ...')
    st, me = api('GET', '/user', token)
    if st == 401:
        die('Token 无效或已过期', '请重新生成一个 Fine-grained token')
    if st != 200:
        die('无法验证 Token（HTTP %s）' % st, json.dumps(me, ensure_ascii=False)[:200])
    log('  Token 属于账号: %s' % me.get('login'))

    st, repo = api('GET', '/repos/%s/%s' % (OWNER, REPO), token)
    if st == 404:
        die('仓库 %s/%s 不存在或 Token 没有权限' % (OWNER, REPO),
            '① 确认仓库已创建 ② 检查 Token 的 Repository access 是否包含这个仓库')
    if st != 200:
        die('读取仓库失败（HTTP %s）' % st, json.dumps(repo, ensure_ascii=False)[:200])
    log('  仓库可访问，默认分支: %s' % repo.get('default_branch'))

    # --- 2. 空仓库需要先建第一个提交 ---
    log('\n[2/6] 检查仓库是否已有提交 ...')
    base_commit_sha, base_tree_sha = ensure_first_commit(token)

    # --- 3. 收集并上传文件（blob） ---
    log('\n[3/6] 上传文件 ...')
    files = collect_files()
    log('  待上传 %d 个文件' % len(files))
    if not files:
        die('没有找到可上传的文件')

    tree_entries = []
    failed = []
    skipped_empty = []
    consecutive_fail = 0
    for i, (rel, full) in enumerate(files, 1):
        with open(full, 'rb') as f:
            content = f.read()

        # 注意：即使是 0 字节文件（例如 docs/.nojekyll），也必须真的调用一次 blob 接口。
        # 之前为了省一次请求直接复用空 blob 的固定哈希，结果创建 tree 时报
        # 422 "tree.sha e69de29b... is not a valid blob" —— 因为该对象在仓库里并不存在。
        expect = blob_sha1(content)
        payload = {
            'content': base64.b64encode(content).decode('ascii'),
            'encoding': 'base64',
        }
        st, res = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO), token, payload)
        if st in (200, 201) and res.get('sha'):
            consecutive_fail = 0
            tree_entries.append({
                'path': rel,
                'mode': '100644',
                'type': 'blob',
                'sha': res['sha'],
            })
            if res['sha'] != expect:
                log('  ⚠ %s 的 sha 与本地计算不一致' % rel)
            if i % 10 == 0 or i == len(files):
                log('  已上传 %d/%d' % (i, len(files)))
        elif not content:
            # 空内容被接口拒绝时，补一个换行再试一次。
            # .nojekyll 的内容无所谓（GitHub 只检查它是否存在于 docs 根目录），
            # 但它是必需的：没有它 GitHub 会用 Jekyll 处理 .md 文件，
            # 导致 docs/assets/安装与使用说明.md 被改写、下载链接失效。
            payload2 = {
                'content': base64.b64encode(b'\n').decode('ascii'),
                'encoding': 'base64',
            }
            st2, res2 = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO), token, payload2)
            if st2 in (200, 201) and res2.get('sha'):
                tree_entries.append({
                    'path': rel, 'mode': '100644', 'type': 'blob', 'sha': res2['sha'],
                })
                log('  ✓ 空文件 %s 已用兼容方式创建（内容补了一个换行）' % rel)
            else:
                log('  ⚠ 空文件 %s 无法创建（HTTP %s），已跳过' % (rel, st2))
                skipped_empty.append(rel)
        else:
            consecutive_fail += 1
            api_msg = res.get('message') if isinstance(res, dict) else ''
            failed.append((rel, st, api_msg or json.dumps(res, ensure_ascii=False)[:200]))
            if consecutive_fail <= 3:
                log('  ✗ %s 失败 (HTTP %s)  %s' % (rel, st, api_msg))
            # 连续失败说明是系统性问题，继续跑下去只会白耗时间
            if consecutive_fail >= 3:
                log('')
                log('  连续 3 个文件失败，判定为系统性问题，提前中止。')
                log('  最后一个错误：HTTP %s  %s' % (st, api_msg))
                break

    if failed:
        # Git Data API 走不通时，自动改用 Contents API 逐个写入（对空仓库一定有效）
        log('')
        log('Git Data API 上传失败（共 %d 个）。改用 Contents API 兜底方案 ...' % len(failed))
        log('  （注意：兜底方案每个文件会产生一次提交）')
        ok2, failed2 = upload_via_contents_api(token, files)
        log('  兜底完成：成功 %d 个，失败 %d 个' % (ok2, len(failed2)))
        if failed2:
            log('')
            for rel, st, msg in failed2[:5]:
                log('  - %s  HTTP %s  %s' % (rel, st, msg))
            die('两条上传路径都失败了，请把上面的错误发给我')
        log('')
        log('  兜底方案成功（文件已逐个提交），跳过 tree/commit 步骤。')
        commit_sha = None
        tree_sha = None
    else:
        # --- 4. 建 tree + commit ---
        log('\n[4/6] 创建目录树和提交 ...')
        tree_payload = {'tree': tree_entries}
        if base_tree_sha:
            # 以已有树为基底，只覆盖/新增本次的文件
            tree_payload['base_tree'] = base_tree_sha
        st, tree = api('POST', '/repos/%s/%s/git/trees' % (OWNER, REPO), token, tree_payload)
        if st not in (200, 201):
            die('创建 tree 失败（HTTP %s）' % st, json.dumps(tree, ensure_ascii=False)[:300])
        tree_sha = tree['sha']
        log('  tree: %s' % tree_sha)

        parents = [base_commit_sha] if base_commit_sha else []
        st, commit = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO), token, {
            'message': '第一次提交：电商图片提取下载插件 + 官方宣传网站',
            'tree': tree_sha,
            'parents': parents,
        })
        if st not in (200, 201):
            die('创建 commit 失败（HTTP %s）' % st, json.dumps(commit, ensure_ascii=False)[:300])
        commit_sha = commit['sha']
        log('  commit: %s' % commit_sha)

        # --- 5. 写入 main 分支 ---
        log('\n[5/6] 写入 %s 分支 ...' % BRANCH)
        st, ref = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPO, BRANCH), token)
        if st == 200:
            st2, res2 = api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPO, BRANCH),
                            token, {'sha': commit_sha, 'force': True})
        else:
            st2, res2 = api('POST', '/repos/%s/%s/git/refs' % (OWNER, REPO), token,
                            {'ref': 'refs/heads/%s' % BRANCH, 'sha': commit_sha})
        if st2 not in (200, 201):
            die('写入分支失败（HTTP %s）' % st2, json.dumps(res2, ensure_ascii=False)[:300])
        log('  %s 已指向 %s' % (BRANCH, commit_sha[:10]))

    # --- 6. 开启 GitHub Pages ---
    log('\n[6/6] 开启 GitHub Pages（源目录 /docs）...')
    st, pages = api('POST', '/repos/%s/%s/pages' % (OWNER, REPO), token,
                    {'source': {'branch': BRANCH, 'path': '/docs'}},
                    ok_status=(409,))
    if st in (200, 201):
        log('  ✓ Pages 已创建')
    elif st == 409:
        log('  Pages 之前已存在，改为更新源配置 ...')
        st_u, upd = api('PUT', '/repos/%s/%s/pages' % (OWNER, REPO), token,
                        {'source': {'branch': BRANCH, 'path': '/docs'}})
        if st_u in (200, 204):
            log('  ✓ Pages 源配置已更新为 /docs')
        else:
            log('  ⚠ 更新 Pages 失败（HTTP %s）' % st_u)
    elif st in (401, 403):
        log('  ⚠ 这个 Token 没有 Pages 权限，无法自动开启')
        log('    不影响代码上传，Pages 可以手动开（见下面提示）')
    else:
        log('  ⚠ 开启 Pages 失败（HTTP %s）' % st)
        log('    %s' % json.dumps(pages, ensure_ascii=False)[:200])

    # --- 核对结果 ---
    log('\n' + '=' * 58)
    log('核对结果')
    log('=' * 58)
    # 兜底模式下没有 tree_sha，直接用分支名当树引用（GitHub 支持传分支名）
    tree_ref = tree_sha or BRANCH
    st, check = api('GET', '/repos/%s/%s/git/trees/%s?recursive=1'
                    % (OWNER, REPO, tree_ref), token)
    if st == 200:
        remote_files = [t['path'] for t in check.get('tree', []) if t.get('type') == 'blob']
        local_files = [rel for rel, _ in files]
        log('  本地文件: %d 个' % len(local_files))
        log('  远端文件: %d 个' % len(remote_files))
        missing = sorted(set(local_files) - set(remote_files))
        extra = sorted(set(remote_files) - set(local_files))
        # 兜底模式会多出初始化用的 README.md 版本，不算问题
        extra = [e for e in extra if e != 'README.md'] if commit_sha is None else extra
        if missing:
            log('  ✗ 远端缺少: %s' % ', '.join(missing[:10]))
        if extra:
            log('  ? 远端多出: %s' % ', '.join(extra[:10]))
        if not missing and not extra:
            log('  ✓ 文件清单完全一致')
        for key in ['docs/index.html', 'docs/css/style.css', 'docs/js/main.js',
                    'plugin/manifest.json', 'plugin/background.js', 'docs/.nojekyll']:
            mark = '✓' if key in remote_files else '✗'
            log('  %s %s' % (mark, key))
    else:
        log('  无法核对文件清单（HTTP %s）' % st)

    log('')
    log('仓库地址: https://github.com/%s/%s' % (OWNER, REPO))
    if commit_sha:
        log('提交地址: https://github.com/%s/%s/commit/%s' % (OWNER, REPO, commit_sha))
    log('')
    log('网站在 1–2 分钟后可访问：')
    log('  https://%s.github.io/%s/' % (OWNER, REPO))
    log('')
    log('如果上面提示 Pages 没开成功，请手动开（约 30 秒）：')
    log('  仓库 → Settings → Pages → Source 选 Deploy from a branch')
    log('  → 分支 main、目录 /docs → Save')


if __name__ == '__main__':
    main()
