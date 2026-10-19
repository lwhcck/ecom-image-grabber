# ==========================================================================
# 把 site/ 官网源码同步到 docs/（GitHub Pages 发布目录），并复制插件图标与安装说明
# 用法：pwsh -File tools\sync-docs.ps1
# ==========================================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 路径都先解析成绝对路径并校验，避免误删误覆盖
$siteDir  = Join-Path $root 'site'
$docsDir  = Join-Path $root 'docs'
$plugin   = Join-Path $root 'plugin'

foreach ($p in @($siteDir, $plugin)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "缺少目录：$p" }
}

Write-Host "源目录：$siteDir"
Write-Host "目标目录：$docsDir"

# ---- 1. 清空并重建 docs ----
if (Test-Path -LiteralPath $docsDir) {
    # 安全检查：只允许删除本脚本同级的 docs 目录
    if ((Split-Path -Parent $docsDir) -ne $root) { throw "拒绝删除非预期目录：$docsDir" }
    Remove-Item -LiteralPath $docsDir -Recurse -Force
}
New-Item -ItemType Directory -Path $docsDir -Force | Out-Null

# ---- 2. 复制官网源码 ----
Copy-Item -Path (Join-Path $siteDir '*') -Destination $docsDir -Recurse -Force

# ---- 3. 复制插件图标到官网 assets/icons（官网离线也要能显示 logo） ----
$docIcons = Join-Path $docsDir 'assets\icons'
New-Item -ItemType Directory -Path $docIcons -Force | Out-Null
Copy-Item -Path (Join-Path $plugin 'icons\*') -Destination $docIcons -Force

# ---- 4. 复制插件安装说明，方便官网访问者下载查阅 ----
$guide = Join-Path $plugin '安装与使用说明.md'
if (Test-Path -LiteralPath $guide) {
    Copy-Item -LiteralPath $guide -Destination (Join-Path $docsDir 'assets\安装与使用说明.md') -Force
}

# ---- 5. 写一个 .nojekyll，避免 GitHub Pages 忽略下划线开头的文件 ----
New-Item -ItemType File -Path (Join-Path $docsDir '.nojekyll') -Force | Out-Null

# ---- 6. 统计结果 ----
$files = Get-ChildItem -LiteralPath $docsDir -Recurse -File
Write-Host ""
Write-Host "同步完成：$($files.Count) 个文件" -ForegroundColor Green
$files | ForEach-Object { "  " + $_.FullName.Replace($root + '\', '') }
