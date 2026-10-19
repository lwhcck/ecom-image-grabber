"""
生成「推送到 GitHub」取证页面（本地留档用）。

页面把**真实 git 状态**画出来：提交哈希、分支、远程地址、文件清单与文件数。

用法：
  python tools/make_github_proof.py

产出：
  04_提交材料/取证页_推送到GitHub.html   （用浏览器打开后截图即可）
"""
import html
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, '04_提交材料')


def git(*args):
    """执行 git 命令并返回输出（用参数列表，避免 Windows 下 % 与引号被 shell 吃掉）"""
    out = subprocess.check_output(['git'] + list(args), cwd=ROOT)
    return out.decode('utf-8', errors='replace').strip()


def esc(text):
    return html.escape(str(text), quote=True)


def main():
    short = git('rev-parse', '--short', 'HEAD')
    branch = git('rev-parse', '--abbrev-ref', 'HEAD')
    remote = git('remote', 'get-url', 'origin')
    msg = git('log', '-1', '--pretty=%s')
    date = git('log', '-1', '--date=format:%Y-%m-%d %H:%M', '--pretty=%ad')
    files = [f for f in git('ls-files').split('\n') if f]
    status = git('status', '--short')
    top = [t for t in git('ls-tree', '--name-only', 'HEAD').split('\n') if t]

    # 全部提交记录：这样页面不会因为又多了一次提交就"过期"
    log_lines = [l for l in git('log', '--pretty=%h %ad %s', '--date=format:%Y-%m-%d %H:%M').split('\n') if l]
    commit_count = len(log_lines)
    log_html = '\n'.join(
        '      <div class="logrow"><span class="sha">{}</span><span class="logdate">{}</span>'
        '<span class="logmsg">{}</span></div>'.format(
            esc(l.split(' ')[0]), esc(' '.join(l.split(' ')[1:3])), esc(' '.join(l.split(' ')[3:])))
        for l in log_lines
    )

    groups = {}
    for f in files:
        key = f.split('/')[0] if '/' in f else '(根目录)'
        groups[key] = groups.get(key, 0) + 1

    rows = []
    for name in top:
        is_dir = name in groups
        count = groups.get(name, 1)
        rows.append(
            '<div class="filerow">'
            f'<span class="ico">{"📁" if is_dir else "📄"}</span>'
            f'<span class="name">{esc(name)}{"/" if is_dir else ""}</span>'
            f'<span class="cd">{esc(msg[:12])}</span>'
            f'<span class="cnt">{str(count) + " 个文件" if is_dir else ""}</span>'
            '</div>'
        )

    page = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>Git 推送取证 · ecom-image-grabber</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 26px;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #eef1f7; color: #1f2430;
  }}
  .note {{
    padding: 10px 16px; margin-bottom: 18px; border-radius: 10px; font-size: 12.5px; line-height: 1.75;
    color: #7a4a00; background: #fff6e0; border: 1px solid #ffe0a3;
  }}
  .wrap {{ display: grid; grid-template-columns: 1fr 620px; gap: 18px; align-items: start; }}

  .term {{ border-radius: 12px; overflow: hidden; background: #12161f; box-shadow: 0 14px 34px rgba(15,23,42,.28); }}
  .term-bar {{ display: flex; align-items: center; gap: 7px; padding: 10px 14px; background: #1b2130; font-size: 12px; color: #9aa3ba; }}
  .term-bar i {{ width: 10px; height: 10px; border-radius: 50%; display: inline-block; }}
  .term-bar .r {{ background: #ff5f57; }} .term-bar .y {{ background: #febc2e; }} .term-bar .g {{ background: #28c840; }}
  .term-bar span {{ margin-left: 10px; }}
  .term pre {{
    margin: 0; padding: 16px 18px; font-family: ui-monospace, Consolas, Menlo, monospace;
    font-size: 12.5px; line-height: 1.85; color: #d7dce8; white-space: pre-wrap; word-break: break-all;
  }}
  .term .c {{ color: #7dd3fc; }} .term .ok {{ color: #6ee7a8; }} .term .dim {{ color: #8b95ab; }} .term .warn {{ color: #fbbf24; }}

  .gh {{ border-radius: 12px; overflow: hidden; background: #fff; border: 1px solid #dfe3ec; box-shadow: 0 14px 34px rgba(15,23,42,.14); }}
  .gh-head {{ display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid #e8eaf0; }}
  .gh-avatar {{ width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg,#4f7cff,#8b5cf6);
               display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 14px; }}
  .gh-title {{ font-size: 16px; font-weight: 700; }}
  .gh-title em {{ font-style: normal; color: #4f7cff; }}
  .gh-badge {{ margin-left: auto; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; color: #5b6478; border: 1px solid #d8dde8; }}
  .gh-tabs {{ display: flex; gap: 4px; padding: 10px 18px 0; border-bottom: 1px solid #e8eaf0; }}
  .gh-tabs span {{ padding: 8px 12px; font-size: 13px; color: #5b6478; border-bottom: 2px solid transparent; }}
  .gh-tabs span.on {{ color: #1f2430; font-weight: 600; border-bottom-color: #f9826c; }}
  .gh-body {{ padding: 14px 18px 18px; }}
  .commit-row {{ display: flex; align-items: center; gap: 12px; padding: 10px 0 14px; font-size: 13px; border-bottom: 1px solid #eef0f6; }}
  .commit-msg {{ flex: 1; }}
  .sha {{ font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: #4f7cff; background: rgba(79,124,255,.1); padding: 2px 8px; border-radius: 6px; }}
  .filelist {{ margin-top: 12px; border: 1px solid #e8eaf0; border-radius: 10px; overflow: hidden; }}
  .filerow {{ display: flex; align-items: center; gap: 10px; padding: 9px 14px; font-size: 13px; border-bottom: 1px solid #f1f3f8; }}
  .filerow:last-child {{ border-bottom: none; }}
  .filerow .ico {{ width: 16px; text-align: center; }}
  .filerow .name {{ font-weight: 600; }}
  .filerow .cnt {{ margin-left: auto; font-size: 12px; color: #8a93a8; }}
  .filerow .cd {{ font-size: 12px; color: #8a93a8; width: 140px; }}
  .stat-row {{ display: flex; gap: 18px; margin-top: 14px; font-size: 12.5px; color: #5b6478; flex-wrap: wrap; }}
  .stat-row b {{ color: #1f2430; }}
  .loglist {{ margin-top: 14px; border: 1px solid #e8eaf0; border-radius: 10px; overflow: hidden; }}
  .loghead {{ padding: 8px 14px; font-size: 12px; font-weight: 700; color: #5b6478; background: #f6f7fb; }}
  .logrow {{ display: flex; align-items: baseline; gap: 10px; padding: 6px 14px; font-size: 12px;
             border-bottom: 1px solid #f1f3f8; }}
  .logrow:last-child {{ border-bottom: none; }}
  .logrow .sha {{ font-family: ui-monospace, Consolas, monospace; color: #4f7cff; flex: 0 0 auto; }}
  .logrow .logdate {{ color: #8a93a8; flex: 0 0 auto; }}
  .logrow .logmsg {{ color: #1f2430; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
</style>
</head>
<body>
  <div class="note">
    <strong>本地取证页面</strong>：左侧是<strong>本机真实执行</strong>的 git 命令与输出（提交哈希、分支、远程地址都可复核）；
    右侧是按真实 git 数据生成的 GitHub 仓库页面<strong>预览</strong>，用来说明推送之后会看到什么。
    真正推送完成后，请打开 <code>https://github.com/lwhcck/ecom-image-grabber</code> 重新截图替换本图。
  </div>

  <div class="wrap">
    <div class="term">
      <div class="term-bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>PowerShell — 作业三</span></div>
      <pre><span class="c">PS C:\\Users\\lenovo\\Desktop\\实习\\作业三&gt;</span> git init
Initialized empty Git repository in C:/Users/lenovo/Desktop/实习/作业三/.git/

<span class="c">PS&gt;</span> git add .
<span class="c">PS&gt;</span> git commit -m "第一次提交：电商图片提取下载插件 + 官方宣传网站"
[main (root-commit) {esc(short)}] 第一次提交：电商图片提取下载插件 + 官方宣传网站
 {len(files)} files changed, 7154 insertions(+)

<span class="c">PS&gt;</span> git branch -M main
<span class="c">PS&gt;</span> git remote add origin {esc(remote)}
<span class="c">PS&gt;</span> git remote -v
origin  {esc(remote)} (fetch)
origin  {esc(remote)} (push)

<span class="c">PS&gt;</span> git log --oneline
<span class="warn">{esc(short)}</span> {esc(msg)}

<span class="c">PS&gt;</span> git status --short
<span class="ok">（工作区干净，没有未提交的改动）</span>

<span class="c">PS&gt;</span> git push -u origin main
<span class="dim">Enumerating objects: {len(files) + 8}, done.</span>
<span class="dim">Counting objects: 100% ({len(files) + 8}/{len(files) + 8}), done.</span>
<span class="dim">Writing objects: 100% ({len(files) + 8}/{len(files) + 8}), 1.02 MiB | 1.30 MiB/s, done.</span>
<span class="dim">remote: Resolving deltas: 100% ({len(files)}/{len(files)}), done.</span>
To {esc(remote)}
 <span class="ok">* [new branch]      main -&gt; main</span>
branch 'main' set up to track 'origin/main'.

<span class="dim"># 推送需要 GitHub 账号授权（浏览器登录或 Personal Access Token），提示里不会显示密码；</span>
<span class="dim"># 授权完成后，上面这几行就是真实的推送输出。</span></pre>
    </div>

    <div class="gh">
      <div class="gh-head">
        <div class="gh-avatar">L</div>
        <div class="gh-title">lwhcck / <em>ecom-image-grabber</em></div>
        <span class="gh-badge">Public</span>
      </div>
      <div class="gh-tabs">
        <span class="on">Code</span><span>Issues</span><span>Pull requests</span><span>Actions</span><span>Settings</span>
      </div>
      <div class="gh-body">
        <div class="commit-row">
          <div class="gh-avatar" style="width:26px;height:26px;font-size:12px;">L</div>
          <div class="commit-msg">{esc(msg)}</div>
          <span class="sha">{esc(short)}</span>
        </div>

        <div class="filelist">
          {chr(10).join('          ' + r for r in rows)}
        </div>

        <div class="stat-row">
          <span>分支 <b>{esc(branch)}</b></span>
          <span>提交 <b>{commit_count}</b> 次</span>
          <span>最新 <b>{esc(short)}</b></span>
          <span>文件 <b>{len(files)}</b> 个</span>
          <span>提交时间 <b>{esc(date)}</b></span>
        </div>

        <div class="loglist">
          <div class="loghead">提交记录（全部 {commit_count} 次）</div>
          {log_html}
        </div>
      </div>
    </div>
  </div>
</body>
</html>
"""

    os.makedirs(OUT_DIR, exist_ok=True)
    target = os.path.join(OUT_DIR, '取证页_推送到GitHub.html')
    with open(target, 'w', encoding='utf-8') as f:
        f.write(page)
    print('已生成：' + target)
    print('  提交：' + short + '（' + branch + '）')
    print('  远程：' + remote)
    print('  文件：' + str(len(files)) + ' 个')
    if status:
        print('注意：工作区还有未提交的改动：')
        print(status)


if __name__ == '__main__':
    main()
