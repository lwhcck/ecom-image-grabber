# ==========================================================================
# 把 plugin/ 目录打包成官网可下载的插件压缩包
# 输出：site\assets\imagegrab-plugin.zip 与 docs\assets\imagegrab-plugin.zip
# 用法：pwsh -File tools\pack-plugin.ps1
# ==========================================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root 'plugin'

if (-not (Test-Path -LiteralPath $plugin)) { throw "缺少插件目录：$plugin" }

# 打包时排除的文件：
#   gallery-mock-data.js 只在本地截图取证（?mock=1）时使用，不分发给使用者
$excludeNames = @('README.md', '作业3_提交说明.md', '安装与使用说明.template.md', 'gallery-mock-data.js')

$stampDir = Join-Path ([System.IO.Path]::GetTempPath()) ("imagegrab-pack-" + [Guid]::NewGuid().ToString('N'))
$stage    = Join-Path $stampDir '图提取-ImageGrab'
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Get-ChildItem -LiteralPath $plugin -Recurse -File | ForEach-Object {
    if ($excludeNames -contains $_.Name) { return }
    $rel    = $_.FullName.Substring($plugin.Length).TrimStart('\')
    $target = Join-Path $stage $rel
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
}

$targets = @(
    (Join-Path $root 'site\assets\imagegrab-plugin.zip'),
    (Join-Path $root 'docs\assets\imagegrab-plugin.zip')
)

foreach ($zip in $targets) {
    $dir = Split-Path -Parent $zip
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
    $size = [Math]::Round((Get-Item -LiteralPath $zip).Length / 1KB, 1)
    Write-Host "已生成：$zip（$size KB）" -ForegroundColor Green
}

Remove-Item -LiteralPath $stampDir -Recurse -Force
