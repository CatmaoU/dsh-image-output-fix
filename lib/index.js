// dsh-image-output-fix — host 半。
//
// 问题根因：DSH Desktop 的 main.js 会把「图片自动转述 helper」（describeImages
// WithVision）注入到多份 dsh-host-apiproxy/lib/index.js。这个 helper 在模型不
// 支持图片输入时会把粘贴的图片转成 `[图片N] ...` 文本再发送，造成“图片被视觉
// AI 解读成文字”的现象。
//
// 更隐蔽的是：某些副本是旧版 helper，不读取 settings.yaml 里
// dsh-vision.autoDescribe: false 的开关；因此即使官方 kill switch 已开启，
// 旧副本仍会继续转述。
//
// 本插件解决方式：在启动时扫描所有已知 dsh-host-apiproxy 副本，在
// describeImagesWithVision 函数体最前面插入 return null，从根源上禁用自动
// 转述。图片会作为附件原样发送，后续可继续由 dsh-vision/view_image 或
// Vision Router 等其他插件按需识图。

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-image-output-fix'
export const inject = []

const MARKER = '// dsh-image-output-fix: keep user images untouched (no auto-describe)'
const FUNC_ANCHOR = 'async function describeImagesWithVision(ctx, content) {'
const BACKUP_SUFFIX = '.dsh-image-output-fix-prebak'
const TMP_SUFFIX = '.dsh-image-output-fix-tmp.mjs'

/**
 * 返回所有已知/可能存在的 dsh-host-apiproxy/lib/index.js 绝对路径。
 * 覆盖 main.js applyImageSendFix 操作的三处运行副本：
 *   - <dshHome>/profiles/node_modules/...
 *   - <appDir>/node_modules/...
 *   - <userDataDir>/agent/node_modules/...
 */
export function apiproxyIndexCandidates() {
  const roots = new Set()
  const home = process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME || ''
  const appData = process.env.APPDATA || ''

  if (process.env.DSH_DESKTOP_APP_DIR) roots.add(process.env.DSH_DESKTOP_APP_DIR)
  roots.add('D:\\dsh\\resources\\app')
  if (process.env.LOCALAPPDATA) {
    roots.add(path.join(process.env.LOCALAPPDATA, 'Programs', 'dsh-desktop', 'resources', 'app'))
    roots.add(path.join(process.env.LOCALAPPDATA, 'Programs', 'dsh', 'resources', 'app'))
  }
  if (home) {
    roots.add(path.join(home, '.dsh'))
    roots.add(path.join(home, '.dsh', 'profiles'))
    roots.add(path.join(home, '.dsh', 'agent'))
  }
  if (appData) {
    roots.add(path.join(appData, 'dsh-desktop'))
    roots.add(path.join(appData, 'dsh'))
  }

  const out = []
  const seen = new Set()
  for (const root of roots) {
    if (!root) continue
    for (const sub of [
      'node_modules',
      'profiles/node_modules',
      'agent/node_modules',
    ]) {
      const target = path.join(root, sub, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js')
      const key = path.normalize(target)
      if (seen.has(key)) continue
      seen.add(key)
      if (existsSync(target)) out.push(target)
    }
  }

  // 按优先顺序去重：用户 profile 副本最常被实际运行，放前面便于日志查看。
  return out.sort((a, b) => {
    const pa = a.includes(`${path.sep}profiles${path.sep}`) ? 0 : 1
    const pb = b.includes(`${path.sep}profiles${path.sep}`) ? 0 : 1
    return pa - pb
  })
}

/**
 * 对一份 dsh-host-apiproxy 源码做注入。
 * @param {string} src 源码
 * @returns {{src: string, status: 'already'|'patched'|'unknown'}}
 */
export function patchApiproxySource(src) {
  if (src.includes(MARKER)) return { src, status: 'already' }
  const idx = src.indexOf(FUNC_ANCHOR)
  if (idx === -1) return { src, status: 'unknown' }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const insertAt = idx + FUNC_ANCHOR.length
  const injection = eol + '\t' + MARKER + eol + '\treturn null;'
  return { src: src.slice(0, insertAt) + injection + src.slice(insertAt), status: 'patched' }
}

/** 对单个目标文件执行备份、注入、语法校验、原子替换。 */
export function patchFile(target, log) {
  log(`→ 检查 ${target}`)
  let src
  try {
    src = readFileSync(target, 'utf8')
  } catch (error) {
    log(`✗ 读取失败：${error.message}`)
    return 'failed'
  }

  const result = patchApiproxySource(src)
  if (result.status === 'already') {
    log(`✓ 已包含修复标记，跳过 ${target}`)
    return 'ok'
  }
  if (result.status === 'unknown') {
    log(`⚠ 未找到 describeImagesWithVision 锚点（版本可能已变更），未修改 ${target}`)
    return 'skipped'
  }

  const bak = target + BACKUP_SUFFIX
  const tmp = target + TMP_SUFFIX
  try {
    if (!existsSync(bak)) copyFileSync(target, bak)
    writeFileSync(tmp, result.src, 'utf8')
    const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 20000 })
    if (check.error || check.status !== 0) {
      const reason = check.error ? check.error.message : (check.stderr || check.stdout || '').split('\n').slice(0, 6).join(' | ')
      log(`✗ 注入后语法校验失败，未写入：${reason}`)
      rmSync(tmp, { force: true })
      return 'failed'
    }
    copyFileSync(tmp, target)
    rmSync(tmp, { force: true })
    log(`✔ 已禁用图片自动转述 ${target}`)
    return 'ok'
  } catch (error) {
    rmSync(tmp, { force: true })
    log(`✗ 写入失败：${error.message}`)
    return 'failed'
  }
}

/** cordis apply：扫描并修复所有已安装副本。 */
export function apply(ctx) {
  const log = (...parts) => {
    const line = `[image-output-fix ${new Date().toISOString()}] ${parts.join(' ')}`
    try { ctx?.logger?.info?.(line) } catch {}
    try {
      const dir = path.join(os.homedir(), '.dsh', 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(path.join(dir, 'image-output-fix.log'), line + '\n', 'utf8')
    } catch {}
  }

  try {
    const targets = apiproxyIndexCandidates()
    if (targets.length === 0) {
      log('⚠ 未找到任何 dsh-host-apiproxy/lib/index.js 副本（可设置 DSH_DESKTOP_APP_DIR 后重试）')
      return
    }
    const summary = {}
    for (const target of targets) summary[target] = patchFile(target, log)
    log('汇总 ' + JSON.stringify(summary, null, 2))
  } catch (error) {
    log('✗ 插件执行异常：' + ((error && error.message) || error))
  }
}

export default { name, inject, apply }