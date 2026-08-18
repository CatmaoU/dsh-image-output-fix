# dsh-image-output-fix one-shot publish script (ASCII only)
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
$ErrorActionPreference = "Stop"

$RepoName = "dsh-image-output-fix"
$RepoFull = "CatmaoU/$RepoName"
$RepoUrl = "https://github.com/$RepoFull.git"
$Version = "0.1.0"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# npm may not be on PATH; use the absolute Windows path.
$Npm = "C:\Program Files\nodejs\npm.cmd"
if (-not (Test-Path -LiteralPath $Npm)) {
  $Npm = "npm"
}

# 1. git init and commit
if (-not (Test-Path -LiteralPath ".git")) {
  git init
}
git add .
git commit -m "fix: disable DSH core image auto-describe, keep image attachments" 2>$null

# 2. ensure remote points to the real GitHub URL
$hasRemote = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0 -or -not $hasRemote) {
  git remote add origin $RepoUrl
} else {
  git remote set-url origin $RepoUrl
}

# 3. create repo only if it does not exist yet
gh repo view $RepoFull >$null 2>$null
if ($LASTEXITCODE -ne 0) {
  gh repo create $RepoFull --public --source=. --remote=origin
}

# 4. make git use gh credentials
gh auth setup-git

# 5. push while bypassing the global gh-proxy insteadOf rewrite.
#    The user-level .gitconfig contains:
#      [url "https://v6.gh-proxy.org/https://github.com/"]
#          insteadOf = https://github.com/
#    A longer insteadOf rule matching the exact target URL makes Git pick it
#    first, so push goes directly to github.com instead of the proxy.
git -c "url.$RepoUrl.insteadOf=$RepoUrl" push -u origin master

# 6. npm pack
& $Npm pack

# 7. publish GitHub Release
$Tgz = Get-ChildItem -Path . -Filter "$RepoName-$Version.tgz" | Select-Object -First 1
if ($null -eq $Tgz) {
  throw "npm pack output not found. Check npm executable: $Npm"
}
gh release create "v$Version" $Tgz.FullName --repo $RepoFull --notes "fix: disable DSH core image auto-describe, keep image attachments"

Write-Host "Published: https://github.com/$RepoFull"
Write-Host "DSH install command: dsh plugin --profile web add github:$RepoFull"