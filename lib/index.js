// dsh-image-output-fix — host 半（磁盘补丁插件）。
//
// 问题根因（v0.3.0 语境）：DSH Desktop / dsh web 的 dsh-host-apiproxy 在收到
// 带图片的 prompt 时，会先按会话当前模型的 inputModalities 分流：模型不支持
// 图片输入，才调用核心 helper describeImagesWithVision(ctx, content) 把图片
// 转述为文字；模型支持图片时图片原样直发、模型原生看图。
//
// 历史版本在本 helper 首行注入短路返回：
//   - v0.1.0 `return null;`：宿主 durablePromptContent(ctx, null) 抛 TypeError，
//     被外层包成 `prompt rejected (agent-busy)`，发图即失败。
//   - v0.2.0 `return content;`：图片原样透传进消息轮，本意交给 dsh-vision-router
//     的 wrapper 改写，但 llm-pi-ai 适配器在 stream() 层直接校验
//     `pi-ai model "…" does not support image input`（UNSUPPORTED_CONTENT）——
//     转述逻辑被短路后，配置的识图模型（settings.yaml dsh-vision.model，如
//     aliyun/qwen3.7-flash）根本没机会被调用，整轮失败。
//
// v0.3.0 决策：不再注入短路返回，而是把 describeImagesWithVision 的整个函数体
// 替换为「有条件转述」实现——
//   - 存在可用识图配置（dsh-vision 段 baseURL + model）且 autoDescribe 未显式
//     关闭时，用该识图模型把每张图片转述为文字（图片块替换为 [图片N] 文本），
//     纯文本消息发给文字模型，避免 UNSUPPORTED_CONTENT；
//   - 未配置识图服务 / autoDescribe === false 时返回 null，调用点回退为图片
//     原样直发（若目标模型不支持图片，错误由模型侧自然暴露——README 有指引）；
//   - 模型本身支持图片的场景不会进入本函数（调用点已分流），图片保持原样。
//
// autoDescribe 开关语义保留：false = 不自动转述。若你的对话模型不支持图片且
// 已配置识图模型，请将 settings.yaml 的 dsh-vision.autoDescribe 设为 true（或
// 在 GUI 设置中开启自动识图），或把对话模型切换为支持图片的模型。

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, appendFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-image-output-fix'
export const inject = []

export const V3_MARKER = '// dsh-image-output-fix: v3'
const V1_MARKER = '// dsh-image-output-fix: keep user images untouched (no auto-describe)'
const V2_MARKER = '// dsh-image-output-fix: passthrough image blocks to dsh-vision-router (v2)'
const FUNC_ANCHOR = 'async function describeImagesWithVision(ctx, content) {'
const BACKUP_SUFFIX = '.dsh-image-output-fix-prebak'
const TMP_SUFFIX = '.dsh-image-output-fix-tmp.mjs'

/**
 * v3 函数体（不含函数签名与闭合花括号），按 tab 缩进与宿主文件一致。
 * 转述逻辑沿用官方实现：逐图并行 fetch 识图服务的 chat/completions，把
 * image part 替换为 [图片N] 文本 part。fetch / AbortSignal 在 apiproxy 环境可用。
 */
const V3_BODY = [
  '\t// dsh-image-output-fix: v3 — transcribe images through the configured dsh-vision VLM',
  '\t// so text-only models (e.g. aliyun/deepseek-v4-flash-0731) can answer instead of',
  '\t// failing with llm-pi-ai UNSUPPORTED_CONTENT. Callers route models WITH image',
  '\t// input around this helper entirely, so images pass through untouched for them.',
  '\tlet vision = null;',
  '\tlet settings;',
  '\ttry { settings = ctx.get("settings"); } catch {}',
  '\tif (settings !== void 0 && typeof settings.get === "function") {',
  '\t\t// 读 HOST 侧解析值（settings.get），不走 redactSecrets 的线快照，避免 apiKey 被抹掉。',
  '\t\ttry { const resolved = settings.get("dsh-vision"); if (resolved !== void 0 && typeof resolved === "object") vision = resolved; } catch {}',
  '\t}',
  '\tif (vision === null && settings !== void 0 && typeof settings.section === "function") {',
  '\t\t// 官方 dsh-vision 插件可能未注册，settings.get 返回 undefined 而原始段仍在：直读文档段。',
  '\t\ttry { const raw = settings.section("dsh-vision"); if (raw !== void 0 && typeof raw === "object") vision = raw; } catch {}',
  '\t}',
  '\tif (vision === null && settings !== void 0 && typeof settings.describe === "function") {',
  '\t\ttry {',
  '\t\t\tconst descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === "dsh-vision");',
  '\t\t\tif (descriptor !== void 0 && descriptor.value !== void 0 && typeof descriptor.value === "object") vision = descriptor.value;',
  '\t\t} catch {}',
  '\t}',
  '\t// 未配置识图服务或 autoDescribe 显式关闭：返回 null，调用点回退为图片原样直发。',
  '\tif (vision === null || vision.autoDescribe === false) return null;',
  '\tif (typeof vision.baseURL !== "string" || vision.baseURL.trim() === "" || typeof vision.model !== "string" || vision.model.trim() === "") return null;',
  '\tconst apiKey = typeof vision.apiKey === "string" ? vision.apiKey.trim() : "";',
  '\tconst endpoint = vision.baseURL.replace(/\\/+$/, "") + "/chat/completions";',
  '\t// 多图并行转述（Promise.all 保序），单张超时 90s。',
  '\tconst describeOne = async (part, imageNo) => {',
  '\t\tconst dataUrl = "data:" + part.mediaType + ";base64," + part.data;',
  '\t\tconst payload = {',
  '\t\t\tmodel: vision.model,',
  '\t\t\tstream: false,',
  '\t\t\tmessages: [',
  '\t\t\t\t{ role: "system", content: "You are an image understanding assistant. Describe the image in exhaustive detail and transcribe every visible text (OCR). If it is a UI, document, table, chart or code, preserve its structure. Answer in Chinese unless the user\'s language clearly differs." },',
  '\t\t\t\t{ role: "user", content: [',
  '\t\t\t\t\t{ type: "text", text: "请把这张图片完整转述为文字：包含画面内容、结构与全部可见文字（逐字 OCR）。" },',
  '\t\t\t\t\t{ type: "image_url", image_url: { url: dataUrl } }',
  '\t\t\t\t] }',
  '\t\t\t]',
  '\t\t};',
  '\t\tconst headers = { "content-type": "application/json" };',
  '\t\tif (apiKey !== "") headers.authorization = "Bearer " + apiKey;',
  '\t\tconst response = await fetch(endpoint, {',
  '\t\t\tmethod: "POST",',
  '\t\t\theaders,',
  '\t\t\tbody: JSON.stringify(payload),',
  '\t\t\tsignal: AbortSignal.timeout(90000)',
  '\t\t});',
  '\t\tif (!response.ok) {',
  '\t\t\tconst bodyText = await response.text().catch(() => "");',
  '\t\t\tthrow new Error("识图服务返回 HTTP " + response.status + "：" + bodyText.slice(0, 400));',
  '\t\t}',
  '\t\tconst data = await response.json();',
  '\t\tconst description = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";',
  '\t\tif (typeof description !== "string" || description.trim() === "") throw new Error("识图服务未返回有效文字描述");',
  '\t\treturn { type: "text", text: "[图片" + imageNo + "] " + description.trim() };',
  '\t};',
  '\tlet imageNo = 0;',
  '\tconst numbered = content.map((part) => (part.type === "image" ? { ...part, _no: ++imageNo } : part));',
  '\tconst out = await Promise.all(numbered.map(async (part) => {',
  '\t\tif (part.type !== "image") return part.type === "text" ? part : null;',
  '\t\treturn describeOne(part, part._no);',
  '\t}));',
  '\treturn out.filter((part) => part !== null);',
].join('\n')

/**
 * 返回所有已知/可能存在的 dsh-host-apiproxy/lib/index.js 绝对路径。
 * 覆盖 main.js applyImageSendFix 操作的三处运行副本：
 *   - <dshHome>/profiles/node_modules/...
 *   - <appDir>/node_modules/...
 *   - <userDataDir>/agent/node_modules/...
 * DSH_HOME 本身就是 dsh 根目录（如 C:\Users\iMuli\.dsh），不能拼「.dsh」。
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
 * 对一份 dsh-host-apiproxy 源码做 v3 注入：用括号匹配定位
 * describeImagesWithVision 的函数体，整体替换为 V3_BODY。
 * v0.1.0 / v0.2.0 的短路注入会被原样覆盖，无需单独迁移步骤。
 * @param {string} src 源码
 * @returns {{src: string, status: 'already'|'patched'|'unknown'}}
 */
export function patchApiproxySource(src) {
  if (src.includes(V3_MARKER)) return { src, status: 'already' }
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
  const newSrc = src.slice(0, bodyStart) + eol + V3_BODY + eol + src.slice(end)
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
    log(`✓ 已是最新补丁（v3），跳过 ${target}`)
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
    log(`✔ 已替换为 v3 有条件识图转述 ${target}`)
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

/** 读取 ~/.dsh/settings.yaml 中 dsh-vision.autoDescribe 的当前值（取字符串或布尔原始值）。 */
export function readAutoDescribeFlag() {
  try {
    const file = path.join(dshRoot(), 'settings.yaml')
    if (!existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8')
    const sectionMatch = text.match(/^dsh-vision:\s*\n([\s\S]*?)(?=^[a-zA-Z][\w-]*:\s*\n|$)/m)
    const body = sectionMatch ? sectionMatch[1] : ''
    const lineMatch = body.match(/^[ \t]*autoDescribe:[ \t]*(true|false|'[^']*'|"[^"]*")\s*$/m)
    if (!lineMatch) return undefined
    return lineMatch[1]
  } catch {
    return undefined
  }
}

/** cordis apply：扫描并修复所有已安装副本，提示 autoDescribe 与模型能力的关系。 */
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
      return
    }
    const summary = {}
    for (const target of targets) summary[target] = patchFile(target, log)
    log('汇总 ' + JSON.stringify(summary, null, 2))

    const autoDescribe = readAutoDescribeFlag()
    if (autoDescribe === 'false') {
      log('⚠ 检测到 settings.yaml dsh-vision.autoDescribe=false：图片将原样直发（不自动转述）。若对话模型不支持图片输入（如 aliyun/deepseek-v4-flash-0731），llm-pi-ai 会报 "does not support image input"；请改 autoDescribe=true（或把对话模型切到支持图片的模型，如 aliyun/qwen3.7-flash）')
    }
  } catch (error) {
    log('✗ 插件执行异常：' + ((error && error.message) || error))
  }
}

export default { name, inject, apply }