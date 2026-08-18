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
 * 检查 DSH credentials 服务文件中是否存在指定凭据条目（只查存在性，不读值）。
 * v0.4.x 视觉链经 llm-pi-ai 的 credentials service 解析 ALIYUN_API_KEY，
 * 本插件从不读取/持有任何明文 apiKey；此检查仅用于启动日志的诊断提示。
 */
function credentialPresent(envName) {
  try {
    const candidates = [path.join(dshRoot(), '.credentials.yaml'), path.join(dshRoot(), 'credentials.yaml')]
    for (const file of candidates) {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      const re = new RegExp(`^[ \\t]*${envName}:[ \\t]*\\S`, 'm')
      if (re.test(text)) return true
    }
  } catch {}
  return false
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
  setSectionKv(lines, changed, 'vision-router', 'routing', 'true')
  setSectionKv(lines, changed, 'dsh-vision', 'autoDescribe', 'false')
  return { text: lines.join('\n'), changed }
}

/** 顶层 section 行范围 `^name:$` … 下一个顶层 section（含末端索引）。 */
function sectionRange(lines, name, startAt = 0) {
  const topRe = /^([A-Za-z][\w-]*):\s*$/
  let idx = -1
  for (let i = startAt; i < lines.length; i++) {
    const m = topRe.exec(lines[i])
    if (m && m[1] === name) { idx = i; break }
  }
  if (idx === -1) return null
  let end = lines.length
  for (let i = idx + 1; i < lines.length; i++) {
    if (topRe.test(lines[i])) { end = i; break }
  }
  return { start: idx, end }
}

/** 在 section 内仅当值缺失或 != want 时覆盖键值（返回是否改动）。 */
function setSectionKv(lines, changed, sectionName, key, want) {
  const range = sectionRange(lines, sectionName)
  if (!range) return false
  let touched = false
  for (let i = range.start + 1; i < range.end; i++) {
    const t = lines[i]
    if (!t.trim() || /^[A-Za-z][\w-]*:\s*$/.test(t) || !/^[ \t]/.test(t)) continue
    const kv = new RegExp(`^([ \\t]*)${key}:[ \\t]*(.*?)[ \\t]*$`).exec(t)
    if (kv && kv[2] !== want) {
      lines[i] = `${kv[1]}${key}: ${want}`
      changed.push(`${sectionName}.${key}: ${kv[2]} → ${want}`)
      touched = true
    }
  }
  return touched
}

/** 在 section 内插入缺失的键值（放在 section 末尾非空行前）。 */
function insertSectionKv(lines, changed, sectionName, key, value) {
  const range = sectionRange(lines, sectionName)
  if (!range) return
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*?)[ \\t]*$`)
  for (let i = range.start + 1; i < range.end; i++) if (re.test(lines[i])) return
  lines.splice(range.end, 0, `  ${key}: ${value}`)
  changed.push(`${sectionName}.${key}:（缺失）→ ${value}`)
}

/**
 * 解析 vision-router.providers 列表（行级）：
 * 返回 { provider, model, start, end }，end 为下一列表项或列表结束行。
 * listIndent 取自首条 `- provider:` 行的缩进；列表结束 = 遇到缩进更浅的非列表行。
 */
function parseProviderItems(lines, providersIdx) {
  const itemStart = /^([ \t]*)-[ \t]*provider:[ \t]*(\S+)[ \t]*$/
  let listIndent = -1
  const items = []
  let cur = null
  for (let i = providersIdx + 1; i < lines.length; i++) {
    const t = lines[i]
    if (!t.trim()) continue
    const ind = (t.match(/^[ \t]*/) || [''])[0].length
    const item = itemStart.exec(t)
    if (item) {
      if (listIndent === -1) listIndent = ind
      if (cur) items.push(cur)
      cur = { provider: item[2], model: '', start: i, end: i + 1 }
      continue
    }
    if (cur === null) break // 尚未出现任何列表项：空列表/格式异常
    if (ind < listIndent) break // 列表结束
    const kv = /^[ \t]*model:[ \t]*(\S+)[ \t]*$/.exec(t)
    if (kv) cur.model = kv[1]
    cur.end = i + 1
  }
  if (cur) items.push(cur)
  return items
}

/** 组装一条 providers 列表项的行（indent=空格数）。 */
function providerItemLines(indent, provider, model) {
  return [
    ' '.repeat(indent) + `- provider: ${provider}`,
    ' '.repeat(indent + 2) + `model: ${model}`,
    ' '.repeat(indent + 2) + 'fallbacks: []',
  ]
}

/**
 * v0.5.0 自愈扫描（幂等）：把本地视觉链收敛到可用且不烧额度的形态。
 * 覆盖「免费额度耗尽 / deadline 饿死 / 重复读图」三类事故现场：
 *   1. siliconflow/Qwen3-VL-32B-Instruct 作为 providers 兜底并置于链首，
 *      aliyun/qwen3.7-flash 保持其后（aliyun 挂起也不再饿死后续后端）。
 *   2. vision-router.visionTaskTimeoutMs ≥ 120000：整链共享预算放大，
 *      单个后端挂起不会在兜底运行前耗尽配额（"budget was exhausted"）。
 *   3. vision-router.rewriteImages = true：图片转述为文本后，后续文本轮
 *      的历史图片块被改写为缓存描述/附件标记，不再把图重复送进视觉链
 *      （避免"每次调用都重新读图、额度持续被烧"）。
 *   4. vision-router.cache = true：同图同问直接命中描述缓存，不重复调视觉 API。
 *   5. llm-pi-ai.providers.siliconflow.models 保证声明
 *      Qwen/Qwen3-VL-32B-Instruct 的 name + input: [text, image]
 *      （否则 vision-router 后端链不认定它是可用图片模型）。
 * 只做最小补丁：已满足的键不动；未显式配置则按上述值补齐。
 * @param {string} text settings.yaml 原文
 * @returns {{text: string, changed: string[]}}
 */
export function vetVisionSettingsText(text) {
  const lines = text.split(/\r?\n/)
  const changed = []

  // 1) 视觉后端链：保证硅基流动兜底存在且优先于 aliyun。
  const vr = sectionRange(lines, 'vision-router')
  if (vr) {
    let providersIdx = -1
    let providersIndent = -1
    for (let i = vr.start + 1; i < vr.end; i++) {
      const m = /^([ \t]*)providers:[ \t]*$/.exec(lines[i])
      if (m) { providersIdx = i; providersIndent = m[1].length; break }
    }
    if (providersIdx !== -1) {
      const items = parseProviderItems(lines, providersIdx)
      const sf = items.find((it) => it.provider === 'siliconflow' && it.model === 'Qwen/Qwen3-VL-32B-Instruct')
      const aliyun = items.find((it) => it.provider === 'aliyun' && it.model === 'qwen3.7-flash')
      const needsReorder = sf && aliyun && sf.start > aliyun.start
      if (!sf) {
        // 兜底缺失：把硅基流动条目插到列表最前（providersIdx + 1）。
        const itemIndent = providersIndent + 2
        lines.splice(providersIdx + 1, 0, ...providerItemLines(itemIndent, 'siliconflow', 'Qwen/Qwen3-VL-32B-Instruct'))
        changed.push('vision-router.providers: + siliconflow/Qwen3-VL-32B-Instruct 兜底（置于链首）')
      } else if (needsReorder) {
        // 兜底在 aliyun 之后：整体重排列表块为 [硅基流动, aliyun, 其余保序]。
        const blockStart = items[0].start
        const blockEnd = items[items.length - 1].end
        const blockIndent = providersIndent + 2
        const rest = items
          .filter((it) => it !== sf && it !== aliyun)
          .map((it) => lines.slice(it.start, it.end))
          .join('\n')
        const rebuilt = [
          providerItemLines(blockIndent, 'siliconflow', 'Qwen/Qwen3-VL-32B-Instruct').join('\n'),
          providerItemLines(blockIndent, 'aliyun', 'qwen3.7-flash').join('\n'),
          rest,
        ].filter(Boolean).join('\n')
        lines.splice(blockStart, blockEnd - blockStart, ...rebuilt.split('\n'))
        changed.push('vision-router.providers: siliconflow 兜底已上移到链首（aliyun 挂起不再饿死兜底）')
      }
    }
    // 2) 整链任务预算兜底 120s：已有值 < 120000 则提升，缺失则插入；
    //    不覆盖用户主动设的更大值（如 180000）。
    ensureMinKv(lines, changed, 'vision-router', 'visionTaskTimeoutMs', 120000, vr)
    // 3) 转述后不再重复读图：rewriteImages / cache 只做 false→true 收敛。
    setBothOrFalseToTrue(lines, changed, 'vision-router', 'rewriteImages')
    setBothOrFalseToTrue(lines, changed, 'vision-router', 'cache')
  }

  // 5) siliconflow 模型目录声明 VL-32B 支持图片（缺声明 → 后端链不认）。
  const pi = sectionRange(lines, 'llm-pi-ai')
  if (pi) {
    const provStart = lines.findIndex((l, i) => i > pi.start && i < pi.end && /^[ \t]*siliconflow:[ \t]*$/.test(l))
    if (provStart !== -1) {
      const provIndent = (lines[provStart].match(/^[ \t]*/) || [''])[0].length
      let provEnd = pi.end
      for (let i = provStart + 1; i < pi.end; i++) {
        const t = lines[i]
        if (!t.trim()) continue
        if ((t.match(/^[ \t]*/) || [''])[0].length <= provIndent) { provEnd = i; break }
      }
      const modelsIdx = lines.findIndex((l, i) => i > provStart && i < provEnd && /^[ \t]*models:[ \t]*$/.test(l))
      if (modelsIdx !== -1) {
        const itemIndentMatch = /^([ \t]*)-/.exec(lines[modelsIdx + 1] || '')
        if (itemIndentMatch) {
          const itemIndent = itemIndentMatch[1].length
          const keyIndent = itemIndent + 2
          const target = lines.findIndex((l, i) => i > modelsIdx && i < evEndOfBlock(lines, modelsIdx, itemIndent) && l.trim() === '- id: Qwen/Qwen3-VL-32B-Instruct')
          if (target !== -1) {
            // 已有该 id：保证紧邻的 name / input 声明（只补缺失的部分）。
            if (!/^[ \t]*name:/.test(lines[target + 1] || '')) {
              lines.splice(target + 1, 0, ' '.repeat(keyIndent) + 'name: Qwen3-VL-32B（视觉）')
              changed.push('llm-pi-ai.siliconflow: Qwen/Qwen3-VL-32B-Instruct + name 声明')
            }
            const nameIdx = lines.findIndex((l, i) => i > target && i < target + 5 && /^[ \t]*name:/.test(l))
            const afterName = nameIdx !== -1 ? nameIdx + 1 : target + 2
            if (!/^[ \t]*input:/.test(lines[afterName] || '')) {
              lines.splice(afterName, 0, ' '.repeat(keyIndent) + 'input: [ text, image ]')
              changed.push('llm-pi-ai.siliconflow: Qwen/Qwen3-VL-32B-Instruct + input:[text,image] 声明')
            }
          } else {
            // models 列表里没有该 id：在列表末尾追加三项（注意列表可能很长，end 取块尾）。
            const end = evEndOfBlock(lines, modelsIdx, itemIndent)
            const tail = `${' '.repeat(itemIndent)}- id: Qwen/Qwen3-VL-32B-Instruct\n` +
              `${' '.repeat(keyIndent)}name: Qwen3-VL-32B（视觉）\n` +
              `${' '.repeat(keyIndent)}input: [ text, image ]`
            lines.splice(end, 0, ...tail.split('\n'))
            changed.push('llm-pi-ai.siliconflow: 追加 Qwen/Qwen3-VL-32B-Instruct（视觉）')
          }
        }
      }
    }
  }

  return { text: lines.join('\n'), changed }
}

/** 列表块结束行索引：从 start 起，首个缩进 <= itemIndent 的「非列表项」行。 */
function evEndOfBlock(lines, start, itemIndent) {
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i]
    if (!t.trim()) continue
    const ind = (t.match(/^[ \t]*/) || [''])[0].length
    const isItem = /^[ \t]*-[ \t]*/.test(t)
    if (!isItem && ind <= itemIndent) return i
  }
  return lines.length
}

/** false → true 收敛（rewriteImages / cache 防重复读图与额度浪费）。 */
function setBothOrFalseToTrue(lines, changed, sectionName, key) {
  const range = sectionRange(lines, sectionName)
  if (!range) return
  for (let i = range.start + 1; i < range.end; i++) {
    const m = new RegExp(`^([ \\t]*)${key}:[ \\t]*(false|true)[ \\t]*$`).exec(lines[i])
    if (m && m[2] === 'false') {
      lines[i] = `${m[1]}${key}: true`
      changed.push(`${sectionName}.${key}: false → true（转述后不再把图重复送进视觉链）`)
    }
  }
}

/** 数字键兜底：值 < min 则提升为 min，值缺失则插入；更大的值保持不动。 */
function ensureMinKv(lines, changed, sectionName, key, min, withinRange) {
  const range = withinRange || sectionRange(lines, sectionName)
  if (!range) return
  const re = new RegExp(`^([ \\t]*)${key}:[ \\t]*(\\d+)[ \\t]*$`)
  for (let i = range.start + 1; i < range.end; i++) {
    const m = re.exec(lines[i])
    if (m && Number(m[2]) >= min) return
    if (m) {
      lines[i] = `${m[1]}${key}: ${min}`
      changed.push(`${sectionName}.${key}: ${m[2]} → ${min}（整链共享预算兜底，避免单后端挂起饿死兜底）`)
      return
    }
  }
  insertSectionKv(lines, changed, sectionName, key, String(min))
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

  // v4 视觉链凭据诊断（只读；本插件从不读取明文 apiKey）
  try {
    const hasCred = credentialPresent('ALIYUN_API_KEY')
    if (hasCred) {
      log('✓ 识别凭据 ALIYUN_API_KEY 已配置（由 DSH Models 页保存于 credentials 服务；本插件不读取 settings.yaml 明文 apiKey）')
    } else {
      log('⚠ 未检测到凭据 ALIYUN_API_KEY。请到 DSH 模型设置页保存 aliyun provider 的 API Key，否则视觉链（qwen3.7-flash 识图）无法鉴权')
    }
    const stPath = settingsPath()
    if (existsSync(stPath)) {
      const st = readFileSync(stPath, 'utf8')
      const plainKey = /^dsh-vision:[ \t]*\r?\n[\s\S]*?^[ \t]*apiKey:[ \t]*\S/m.test(st)
      if (plainKey) log('ℹ settings.yaml 中 dsh-vision.apiKey 明文仅为 v3 遗留参考，v0.4.x 不再读取；可手动删除该键（key 已失效也不影响视觉链）')
    }
  } catch {}

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
    // v0.5.0：先做 v4 既有收敛（routing/autoDescribe），再做视觉链自愈
    //（硅基流动兜底优先 + 预算 120s + rewrite/cache 防重复读图 + VL-32B 声明）。
    const base = patchSettingsText(src)
    const vet = vetVisionSettingsText(base.text)
    const changed = [...base.changed, ...vet.changed]
    if (changed.length === 0) {
      log('✓ settings.yaml 已符合 v0.5.0 要求（routing=true · 视觉链兜底 · 预算/防重复读图）')
      return
    }
    const bak = p + SETTINGS_BAK_SUFFIX
    if (!existsSync(bak)) copyFileSync(p, bak)
    writeFileSync(p, vet.text, 'utf8')
    log('✔ 已修正 settings.yaml：' + changed.join('；') + '（备份 ' + bak + '；重启后生效）')
  } catch (error) {
    log('✗ settings.yaml 修正失败：' + ((error && error.message) || error))
  }
}

export default { name, inject, apply }