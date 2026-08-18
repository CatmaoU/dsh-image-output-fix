# dsh-image-output-fix 一键发布脚本
# 作用：初始化 git -> 创建 GitHub 仓库 -> 推送 -> npm pack -> 发布 GitHub Release
# 用法：在 PowerShell 中执行
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
$ErrorActionPreference = "Stop"

$RepoName = "dsh-image-output-fix"
$Version = "0.1.0"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 1. git 初始化与提交
if (-not (Test-Path ".git")) {
  git init
}
git add .
git commit -m "fix: disable DSH core image auto-describe, keep image attachments"

# 2. 创建 GitHub 仓库并推送
# 如果仓库已存在，可改用：
#   git remote add origin https://github.com/CatmaoU/$RepoName.git
gh repo create $RepoName --public --source=. --remote=origin --push

# 3. 构建 npm 包
npm pack

# 4. 发布 GitHub Release
$Tgz = Get-ChildItem -Path . -Filter "$RepoName-$Version.tgz" | Select-Object -First 1
if ($null -eq $Tgz) {
  throw "未找到 npm pack 产物"
}
gh release create "v$Version" $Tgz.FullName --notes "fix: disable DSH core image auto-describe, keep image attachments"

Write-Host "发布完成：https://github.com/CatmaoU/$RepoName"
Write-Host "DSH 安装命令：dsh plugin --profile web add github:CatmaoU/$RepoName"