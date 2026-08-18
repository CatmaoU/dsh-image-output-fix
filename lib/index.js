// dsh-image-output-fix — host 半（磁盘补丁插件）。
//
// 目标链路（v0.4.0，用户期望形态）：
//   用户发送图片 → 图片原样发送成功（不被转述成文本，界面显示原图）
//   → dsh-vision-router 把图片轮切到视觉链（vision-chain），由用户在
//     Vision Router 里选择的识别模型（如 aliyun/qwen3.7-flash）识图
//   → 图片轮的答复呈现给用户；文字轮由 reverseRouting 切回 textProvider
//     （如 aliyun/deepseek-v4-flash-0731）保持日常对话模型。
//
// 历史根因链：
//   - DSH dsh-host-apiproxy 的 prompt handler（约 2908 行起）先按会话模型
//     的 inputModalities 分流：模型不支持图片输入时调用核心 helper
//     describeImagesWithVision(ctx, content) 把图片转述为文字。
//   - v0.1.0 注入 `return null;`：durablePromptContent(ctx, null) 抛
//     TypeError → `prompt rejected (agent-busy)`，发图即失败。
//   - v0.2.0 注入 `return content;`（图片透传给 dsh-vision-router 接管），
//     但本机 vision-router 的 routing:false 时 agent/request 不改路由，
//     图片轮仍由纯文本模型接收 → llm-pi-ai adapter.ts:303-305 硬拒
//     `pi-ai model "…" does not support image input`。
//   - v0.3.0 恢复「有条件转述」（识别模型把图片转述为 [图片N] 文本），
//     不再报错，但把用户的图片替换成了长篇转述文本（转录里难看且有损）。
//
// v0.4.0 决策：
//   1. helper 保持透传（return content）：图片以 durable attachment 进入
//      消息轮，界面保留原图；转述交给 vision-router 的视觉链完成。
//   2. apply 时修正 settings.yaml：vision-router.routing false → true
//      （图片轮由 vision-router 切到视觉链识别；文本轮 reverseRouting 回
//      textProvider），并还原 dsh-vision.autoDescribe 为 false（v4 不再
//      依赖自动转述）。豁免：DSH_IMAGE_OUTPUT_FIX_NO_SETTINGS=1 时跳过。
//   3. 始终不返回 null（宿主会崩）、不在 helper 内转述（转录被污染）。

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, appendFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-image-output-fix'
export const inject = []

export const V4_MARKER = '// dsh-image-output-fix: v4'
const FUNC_ANCHOR = 'async function describeImagesWithVision(ctx, content) {'
const BACKUP_SUFFIX = '.dsh-image-output-fix-prebak'
const TMP_SUFFIX = '.dsh-image-output-fix-tmp.mjs'
const SETTINGS_BAK_SUFFIX = '.dsh-image-output-fix-bak'

/**
 * v4 函数体（不含函数签名与闭合花括号），tab 缩进与宿主文件一致。
 * 透传语义：返回原 content（图片块），由 vision-router 视觉链接管识图。
 */
const V4_BODY = [
  '\t// dsh-image-output-fix: v4 — keep image blocks untouched (passthrough).',
  '\t// The prompt handler only calls this helper when the session model has no',
  '\t// image input. Returning content sends the image into the message stream as',
  '\t// a durable attachment; dsh-vision-router (routing=true) switches the image',
  '\t// turn to its vision chain so the configured vision model (e.g.',
  '\t// aliyun/qwen3.7-flash) reads it, while reverseRouting keeps text turns on',
  '\t// the text provider (e.g. aliyun/deepseek-v4-flash-0731).',
  '\t// Never return null (durablePromptContent crashes the host) and never',
  '\t// transcribe here (that replaces the user image with a text dump).',
  '\treturn content;',
].join('\n')

/**
 * 返回所有已知/可能存在的 dsh-host-apiproxy/lib/index.js 绝对路径。
 * 覆盖 main.js applyImageSendFix 操作的三处运行副本；
 * profiles 副本可能是指向 agent 目录的 junction，物理去重见调用方。
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
    for (const sub of ['node_modules', 'profiles/node_modules', 'agent/node_modules']) {
      const target = path.join(root, sub, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js')
      const key = path.normalize(target)
      if (seen.has(key)) continue
      seen.add(key)
      if (existsSync(target)) out.push(target)
    }
  }

  return out.sort((a, b) => {
    const pa = a.includes(`${path.sep}profiles${path.sep}`) ? 0 : 1
    const pb = b.includes(`${path.sep}profiles${path.sep}`) ? 0 : 1
    return pa - pb
  })
}

/**
 * 对一份 dsh-host-apiproxy 源码做 v4 注入：括号匹配定位
 * describeImagesWithVision 的函数体并整体替换为 V4_BODY（透传）。
 * v0.1.0 / v0.2.0 / v0.3.0 的注入均被原样覆盖。
 * @param {string} src 源码
 * @returns {{src: string, status: 'already'|'patched'|'unknown'}}
 */
export function patchApiproxySource(src) {
  if (src.includes(V4_MARKER)) return { src, status: 'already' }
  const start = src.indexOf(FUNC_ANCHOR)
  if (start === -1) return { src, status: 'unknown' }

  const bodyStart = start + FUNC_ANCHOR.length // 指向 '{' 之后
  let depth = 0
  let end = -1
  for (let i = bodyStart - 1; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1 || depth !== 0) return { src, status: 'unknown' }

  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const newSrc = src.slice(0, bodyStart) + eol + V4_BODY + eol + src.slice(end)
  return { src: newSrc, status: 'patched' }
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
    log(`✓ 已是最新补丁（v4 透传），跳过 ${target}`)
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
    log(`✔ 已替换为 v4 图片透传（vision-router 接管识图） ${target}`)
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

/** settings.yaml 绝对路径。 */
function settingsPath() {
  return path.join(dshRoot(), 'settings.yaml')
}

/**
 * 修正 settings.yaml 的段内键值（纯文本行级，缩进=空格）。
 * - vision-router.routing: false → true（图片轮交由视觉链接管）
 * - dsh-vision.autoDescribe: true → false（v4 不再依赖自动转述）
 * @param {string} text settings.yaml 原文
 * @returns {{text: string, changed: string[]}}
 */
export function patchSettingsText(text) {
  const lines = text.split(/\r?\n/)
  const changed = []
  const setKv = (sectionName, key, want) => {
    let inSection = false
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]
      const secMatch = /^([A-Za-z][\w-]*):\s*$/.exec(t)
      if (secMatch) {
        inSection = secMatch[1] === sectionName
        continue
      }
      if (!inSection || !/^[ \t]/.test(t)) continue
      const kv = new RegExp(`^([ \\t]*)${key}:[ \\t]*(.*?)[ \\t]*$`).exec(t)
      if (kv && kv[2] !== want) {
        lines[i] = `${kv[1]}${key}: ${want}`
        changed.push(`${sectionName}.${key}: ${kv[2]} → ${want}`)
        break
      }
    }
  }
  setKv('vision-router', 'routing', 'true')
  setKv('dsh-vision', 'autoDescribe', 'false')
  return { text: lines.join('\n'), changed }
}

/** 读 dsh-vision.autoDescribe 当前值，供日志提示。 */
export function readAutoDescribeFlag() {
  try {
    const file = settingsPath()
    if (!existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8')
    const sectionMatch = text.match(/^dsh-vision:\s*\n([\s\S]*?)(?=^[a-zA-Z][\w-]*:\s*\n|$)/m)
    const body = sectionMatch ? sectionMatch[1] : ''
    const lineMatch = body.match(/^[ \t]*autoDescribe:[ \t]*(true|false)\s*$/m)
    if (!lineMatch) return undefined
    return lineMatch[1]
  } catch {
    return undefined
  }
}

/** cordis apply：span 三处 apiproxy 副本为 v4 透传，并修正 settings.yaml。 */
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
      log('⚠ 未找到任何 dsh-host-apiproxy/lib/index.js 副本（可设置 DSH_DESKTOP_APP_DIR 或 DSH_HOME 后重试）')
    } else {
      const summary = {}
      for (const target of targets) summary[target] = patchFile(target, log)
      log('汇总 ' + JSON.stringify(summary, null, 2))
    }
  } catch (error) {
    log('✗ apiproxy 补丁执行异常：' + ((error && error.message) || error))
  }

  if (process.env.DSH_IMAGE_OUTPUT_FIX_NO_SETTINGS === '1') {
    log('⚠ 已跳过 settings.yaml 修正（DSH_IMAGE_OUTPUT_FIX_NO_SETTINGS=1）。请手动把 vision-router.routing 设为 true，否则图片轮仍可能报 pi-ai does not support image input')
    return
  }
  try {
    const p = settingsPath()
    if (!existsSync(p)) {
      log('⚠ 未找到 settings.yaml（' + p + '），跳过配置修正')
      return
    }
    const src = readFileSync(p, 'utf8')
    const { text, changed } = patchSettingsText(src)
    if (changed.length === 0) {
      log('✓ settings.yaml 已符合 v4 要求（vision-router.routing=true）')
      return
    }
    const bak = p + SETTINGS_BAK_SUFFIX
    if (!existsSync(bak)) copyFileSync(p, bak)
    writeFileSync(p, text, 'utf8')
    log('✔ 已修正 settings.yaml：' + changed.join('、') + '（备份 ' + bak + '；重启后图片轮将由 vision-router 视觉链接管）')
  } catch (error) {
    log('✗ settings.yaml 修正失败：' + ((error && error.message) || error))
  }
}

export default { name, inject, apply }