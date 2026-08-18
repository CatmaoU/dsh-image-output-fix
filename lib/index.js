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
// v0.2.0 改造（兼容 dsh-vision-router 的图片转述）：
// - 不再向 helper 注入 return null。v0.1.0 的 return null 会让宿主
//   durablePromptContent(ctx, null) 抛 TypeError，被外层层包成
//   `prompt rejected (agent-busy)`，导致发图即失败。
// - 改为注入 `return content`：图片块原样透传给消息轮，由
//   dsh-vision-router 的 pre-step 记录 rawImageRefs / 挂载视觉工具，其
//   wrapper adapter（deepseek-vision，默认无条件注册）会在模型输入层把图片
//   改写成可见标记，模型再通过 vision_describe 等工具完成识图。
// - 已装 v0.1.0 旧补丁（return null）的副本会被原地迁移为 return content。
// - apply 时检测 dsh-vision-router 是否已安装；未安装则自动调用
//   `dsh plugin --profile <p> add dsh-vision-router` 作为前置安装（后台执行，
//   可用 DSH_IMAGE_OUTPUT_FIX_NO_AUTO_INSTALL=1 关闭）。
//
// 图片链路（安装本插件 + vision-router 后）：
//   用户发图 → 宿主检测到模型不支持图片 → describeImagesWithVision 被调用
//   → 本插件注入口直接 return content → durablePromptContent 把图片存为
//   attachment 引用进入消息轮 → vision-router pre-step 记录图片、注入提醒、
//   挂载 vision 工具 → wrapper adapter 在模型输入层改写图片块为标记
//   → 模型调用 vision_describe / vision_ground 等完成识图。

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, appendFileSync, readdirSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-image-output-fix'
export const inject = []

const MARKER = '// dsh-image-output-fix: passthrough image blocks to dsh-vision-router (v2)'
const LEGACY_MARKER = '// dsh-image-output-fix: keep user images untouched (no auto-describe)'
const FUNC_ANCHOR = 'async function describeImagesWithVision(ctx, content) {'
const BACKUP_SUFFIX = '.dsh-image-output-fix-prebak'
const TMP_SUFFIX = '.dsh-image-output-fix-tmp.mjs'

const VISION_ROUTER_PKG = 'dsh-vision-router'
/** 设为 '1' 可关闭自动安装前置插件。 */
const NO_AUTO_INSTALL = process.env.DSH_IMAGE_OUTPUT_FIX_NO_AUTO_INSTALL === '1'
/** 指定自动安装的目标 profile，默认取 DSH_HOME/profiles 下的 web 或第一个目录。 */
const PROFILE_OVERRIDE = process.env.DSH_IMAGE_OUTPUT_FIX_PROFILE || ''

/**
 * 返回所有已知/可能存在的 dsh-host-apiproxy/lib/index.js 绝对路径。
 * 覆盖 main.js applyImageSendFix 操作的三处运行副本：
 *   - <dshHome>/profiles/node_modules/...
 *   - <appDir>/node_modules/...
 *   - <userDataDir>/agent/node_modules/...
 * 注意：DSH_HOME 本身就是 dsh 根目录（如 C:\Users\iMuli\.dsh），不能再拼
 * 「.dsh」；agent 副本也可能位于 APPDATA\DSH Desktop\agent 下。
 */
export function apiproxyIndexCandidates() {
  const roots = new Set()
  const dshHome = process.env.DSH_HOME || ''
  const userHome = process.env.USERPROFILE || process.env.HOME || ''
  const appData = process.env.APPDATA || ''
  const localAppData = process.env.LOCALAPPDATA || ''

  if (process.env.DSH_DESKTOP_APP_DIR) roots.add(process.env.DSH_DESKTOP_APP_DIR)
  roots.add('D:\\dsh\\resources\\app')
  if (localAppData) {
    roots.add(path.join(localAppData, 'Programs', 'dsh-desktop', 'resources', 'app'))
    roots.add(path.join(localAppData, 'Programs', 'dsh', 'resources', 'app'))
  }
  if (dshHome) {
    // DSH_HOME 已是 dsh 根目录
    roots.add(dshHome)
    roots.add(path.join(dshHome, 'profiles'))
    roots.add(path.join(dshHome, 'agent'))
  }
  if (!dshHome && userHome) {
    roots.add(path.join(userHome, '.dsh'))
    roots.add(path.join(userHome, '.dsh', 'profiles'))
    roots.add(path.join(userHome, '.dsh', 'agent'))
  }
  if (appData) {
    // 桌面版数据目录的实际名字有三种历史形态
    for (const dirName of ['dsh-desktop', 'dsh', 'DSH Desktop']) {
      const root = path.join(appData, dirName)
      roots.add(root)
      roots.add(path.join(root, 'agent'))
    }
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
 * 对一份 dsh-host-apiproxy 源码做注入/迁移。
 * v0.2.0 语义：让 describeImagesWithVision 直接把 content 原样透传，
 * 图片进消息轮由 dsh-vision-router 接管；禁止 return null（会崩宿主）。
 * @param {string} src 源码
 * @returns {{src: string, status: 'already'|'patched'|'migrated'|'unknown'}}
 */
export function patchApiproxySource(src) {
  if (src.includes(MARKER)) return { src, status: 'already' }
  const idx = src.indexOf(FUNC_ANCHOR)
  if (idx === -1) return { src, status: 'unknown' }

  // 旧版 v0.1.0 补丁：`// ...no auto-describe)` 后紧跟 `return null;`
  const legacyRe = /(\/\/ dsh-image-output-fix: keep user images untouched \(no auto-describe\)\r?\n\t)return null;/
  if (legacyRe.test(src)) {
    const stepped = src.replace(legacyRe, `$1return content;`).replace(LEGACY_MARKER, MARKER)
    return { src: stepped, status: 'migrated' }
  }

  // 全新注入
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const insertAt = idx + FUNC_ANCHOR.length
  const injection = eol + '\t' + MARKER + eol + '\treturn content;'
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
    log(`✓ 已是最新补丁，跳过 ${target}`)
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
    log(`✔ ${result.status === 'migrated' ? '已迁移旧补丁(return null → return content)' : '已改为图片透传，交由 dsh-vision-router 接管'} ${target}`)
    return 'ok'
  } catch (error) {
    rmSync(tmp, { force: true })
    log(`✗ 写入失败：${error.message}`)
    return 'failed'
  }
}

/** DSH 根目录：DSH_HOME 本身即是（不再拼 .dsh）。 */
function dshRoot() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 枚举 DSH_HOME/profiles 下的真实 profile 目录名。
 * 排除：隐藏目录、备份目录、pnpm workspace 里平铺的系统包（cordis-*、
 * dsh-*、cosmokit 等）、无 node_modules 的目录。真实 profile 通常是 web。 */
export function listProfileNames() {
  const profilesRoot = path.join(dshRoot(), 'profiles')
  if (!existsSync(profilesRoot)) return []
  const names = []
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (/(?:[-.]?(?:old|bak|backup|skeleton-bak|skeleton))(?:[-.]|$)/i.test(entry.name)) continue
    if (/^(cordis|cordis-plugin|cordis-plugin-group|cosmokit|dsh|schemastery|node_modules)(-|$)/i.test(entry.name)) continue
    const nm = path.join(profilesRoot, entry.name, 'node_modules')
    if (existsSync(nm)) names.push(entry.name)
  }
  return names.sort()
}

/**
 * dsh-vision-router 是否已安装（根目录、profiles 根、或任一 profile 自己的
 * node_modules 下有该包）。pnpm 的 node_modules 可能 hoist 到不同层级，
 * 所以三层都要查。
 */
export function isVisionRouterInstalled() {
  const bases = [dshRoot()]
  const profilesRoot = path.join(dshRoot(), 'profiles')
  if (existsSync(profilesRoot)) {
    bases.push(profilesRoot)
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        bases.push(path.join(profilesRoot, entry.name))
      }
    }
  }
  for (const base of bases) {
    const dir = path.join(base, 'node_modules', VISION_ROUTER_PKG)
    if (!existsSync(dir)) continue
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (pkg?.name === VISION_ROUTER_PKG || (pkg?.name || '').endsWith(`/${VISION_ROUTER_PKG}`)) return true
    } catch { /* 无法读取视为未安装 */ }
  }
  return false
}

/**
 * 前置检查：未安装 dsh-vision-router 时自动安装（后台执行，不阻塞启动）。
 * 复用 dshmarket 的 spawn 模式：Windows 上 dsh 是 .cmd shim，必须走
 * cmd.exe /d /s /c 显式构命令行。
 */
export function ensureVisionRouter(ctx, log) {
  if (isVisionRouterInstalled()) {
    log('✓ 前置 dsh-vision-router 已安装')
    return
  }
  if (NO_AUTO_INSTALL) {
    log('⚠ 未检测到 dsh-vision-router，且 DSH_IMAGE_OUTPUT_FIX_NO_AUTO_INSTALL=1 已关闭自动安装。请手动执行：dsh plugin add dsh-vision-router')
    return
  }
  const names = listProfileNames()
  const profile = PROFILE_OVERRIDE || (names.includes('web') ? 'web' : names[0])
  if (!profile) {
    log('⚠ 未检测到 dsh-vision-router，且找不到可用的 DSH profile 目录，跳过自动安装（请手动安装）')
    return
  }

  const args = ['plugin', '--profile', profile, 'add', VISION_ROUTER_PKG]
  const env = { ...process.env, CI: 'true' }
  let child
  if (process.platform === 'win32') {
    const cmdLine = ['dsh', ...args].map((arg) => (/[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)).join(' ')
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
      env,
    })
  } else {
    child = spawn('dsh', args, { detached: true, stdio: 'ignore', env })
  }
  child.on('error', (error) => log(`✗ 自动安装启动失败：${error.message}（请手动执行 dsh plugin --profile ${profile} add ${VISION_ROUTER_PKG}）`))
  child.on('close', (code) => {
    if (code === 0) log(`✔ 已自动安装前置 ${VISION_ROUTER_PKG}（profile=${profile}）。重启 DSH 后即可让图片轮由 vision-router 接管识图。`)
    else log(`✗ 自动安装 ${VISION_ROUTER_PKG} 退出码 ${code}，请手动执行：dsh plugin --profile ${profile} add ${VISION_ROUTER_PKG}`)
  })
  // ensure 返回后不阻塞 cordis 启动（后台安装）
  child.unref()
  log(`→ 未检测到 ${VISION_ROUTER_PKG}，已启动后台自动安装：dsh ${args.join(' ')}（日志见后；安装完成需重启 DSH）`)
}

/** cordis apply：先保证前置插件，再扫描并修复所有已安装副本。 */
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
    ensureVisionRouter(ctx, log)
  } catch (error) {
    log('⚠ 前置检查异常（不影响补丁修复）：' + ((error && error.message) || error))
  }

  try {
    const targets = apiproxyIndexCandidates()
    if (targets.length === 0) {
      log('⚠ 未找到任何 dsh-host-apiproxy/lib/index.js 副本（可设置 DSH_DESKTOP_APP_DIR 或 DSH_HOME 后重试）')
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