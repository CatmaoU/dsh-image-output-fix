// v0.6.0 自测：patchApiproxySource v5 三件套 + vetNativeVisionSettingsText 幂等。
// node scripts/v6-self-test.mjs
import { patchApiproxySource, isNativeVisionModelName, vetNativeVisionSettingsText } from '../lib/index.js'
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}`) }
}

/** 指定 - id: ... 条目是否带 input 声明（条目块 = 到下一 - 或缩进回退为止）。 */
function hasInputDecl(lines, id) {
  const hit = lines.findIndex((l) => l.trim() === `- id: ${id}`)
  if (hit === -1) return false
  const itemIndent = (lines[hit].match(/^[ \t]*/) || [''])[0].length
  for (let j = hit + 1; j < lines.length; j++) {
    const t = lines[j]
    if (!t.trim()) continue
    const ind = (t.match(/^[ \t]*/) || [''])[0].length
    if (/^[ \t]*-[ \t]*/.test(t) || ind <= itemIndent) return false
    if (/^[ \t]*input:[ \t]*\[?\s*text\b[^\]]*image/i.test(t)) return true
  }
  return false
}

// ── 1. 探测函数单元 ──────────────────────────────────────────────────────
console.log('1) isNativeVisionModelName')
ok(isNativeVisionModelName('DeepSeek-V4-Flash-Vision-Exp') === true, '官方名命中')
ok(isNativeVisionModelName('deepseek-ai/DeepSeek-V4-Flash-Vision-Exp') === true, '带 provider 前缀命中')
ok(isNativeVisionModelName('DeepSeek-V4-Flash-Vision-Exp-aliyun') === true, '运营商后缀变体命中')
ok(isNativeVisionModelName('某运营商/DeepSeek-V4-Flash-Vision-Exp') === true, '中文前缀变体命中')
ok(isNativeVisionModelName('DeepSeek-V4-Flash') === false, '纯文本 Flash 不命中')
ok(isNativeVisionModelName('deepseek-v4-flash') === false, '小写纯文本 Flash 不命中')
ok(isNativeVisionModelName('DeepSeek-V4-Pro') === false, 'Pro 不命中')
ok(isNativeVisionModelName('Qwen/Qwen3-VL-Embedding-8B') === false, 'embedding 排除')
ok(isNativeVisionModelName('Qwen/Qwen3-VL-Reranker-8B') === false, 'reranker 排除')
ok(isNativeVisionModelName('') === false, '空串 false')

// ── 2. patchApiproxySource：干净宿主原型 → v5 → already ──────────────────
console.log('2) patchApiproxySource（clean → v5 → already）')
const CLEAN = `// host bundle
async function describeImagesWithVision(ctx, content) {
	return originalBody(ctx, content);
}
async function prompt(request) {
	const { sessionId, mode, content, clientTimeZone } = request.payload;
	let admittedContent = content;
	const hasImage = content.some((part) => part.type === "image");
	const admit = async () => {
		try {
			if (hasImage) {
				const current = selectionFor(agent).current;
				const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
				if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {
				try {
					admittedContent = await describeImagesWithVision(ctx, content);
				} catch (error) {
					return err(request, { code: "attachment-error" });
				}
			}
			}
			const message = createUserMessage({
				content: await durablePromptContent(ctx, admittedContent),
				source
			});
		} catch (error) {}
	};
}
`
{
  const r1 = patchApiproxySource(CLEAN)
  ok(r1.status === 'patched', `clean → patched（got ${r1.status}）`)
  const s = r1.src
  ok(s.includes('// dsh-image-output-fix: v5'), 'V5_MARKER 注入')
  ok(s.includes('if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && !isDshImageOutputFixNativeVision(current.model)) {'), '调用点豁免注入')
  ok(s.includes('function isDshImageOutputFixNativeVision(model) {'), '探测函数注入')
  ok(s.includes('\treturn content;'), 'helper 透传体存在')
  ok(!s.includes('return originalBody(ctx, content);'), '原 helper 体被替换')
  const r2 = patchApiproxySource(s)
  ok(r2.status === 'already', `二次执行 power 幂等（got ${r2.status}）`)
  ok(r2.src === s, '二次执行原文不变')
}

// ── 3. patchApiproxySource：已 v4 宿主 → v5 升级 ─────────────────────────
console.log('3) patchApiproxySource（v4 → v5 升级）')
{
  const V4 = CLEAN.replace(
    'return originalBody(ctx, content);',
    '// dsh-image-output-fix: v4 — keep image blocks untouched (passthrough).\n\treturn content;',
  )
  const r = patchApiproxySource(V4)
  ok(r.status === 'patched', `v4 → patched（got ${r.status}）`)
  ok(r.src.includes(CALL_FIXED_SNIPPET()), 'v4 升级后调用点豁免注入')
  ok(r.src.includes('// dsh-image-output-fix: v5'), 'v4 升级后 V5 marker 注入')
  ok(r.src.split('function isDshImageOutputFixNativeVision(model) {').length === 2, '探测函数仅一份')
  const r2 = patchApiproxySource(r.src)
  ok(r2.status === 'already' && r2.src === r.src, '升级后再跑 already 且不变')
}
function CALL_FIXED_SNIPPET() {
  return 'isDshImageOutputFixNativeVision(current.model)'
}

// ── 4. vetNativeVisionSettingsText：合并/声明/幂等 ────────────────────────
console.log('4) vetNativeVisionSettingsText')
const SETTINGS_BEFORE = `llm-pi-ai:
  providers:
    siliconflow:
      api: openai-completions
      models:
        - id: deepseek-ai/DeepSeek-V4-Flash
        - id: deepseek-ai/DeepSeek-V4-Flash-Vision-Exp
        - id: 运营商A/DeepSeek-V4-Flash-Vision-Exp
        - id: Qwen/Qwen3-VL-32B-Instruct
          name: Qwen3-VL-32B（视觉）
          input: [ text, image ]
vision-router:
  onboardingSeen: true
  routing: true
  extraVisionModels:
    - Gemini
  providers:
    - provider: siliconflow
      model: Qwen/Qwen3-VL-32B-Instruct
      fallbacks: []
  textProvider:
    provider: aliyun
    model: deepseek-v4-flash-0731
dsh-vision:
  autoDescribe: false
`
{
  const r = vetNativeVisionSettingsText(SETTINGS_BEFORE)
  const lines = r.text.split('\n')
  const joined = r.text
  // input 声明补全（V4-Flash-Vision-Exp 与运营商变体；Qwen VL 已有不动）
  ok(hasInputDecl(lines, 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp'), '官方 Flash-Vision 补 input 声明')
  ok(hasInputDecl(lines, '运营商A/DeepSeek-V4-Flash-Vision-Exp'), '运营商变体补 input 声明')
  ok(!hasInputDecl(lines, 'deepseek-ai/DeepSeek-V4-Flash'), '纯文本 Flash 不加 input')
  const inputLineCount = joined.split('\n').filter((l) => /^[ \t]*input:/.test(l)).length
  ok(inputLineCount === 3, `input 声明共 3 条（Qwen 已有 1 + 新增 2，实际 ${inputLineCount}）`)
  // extraVisionModels 合并
  ok(joined.includes('DeepSeek-V4-Flash-Vision-Exp'), '官方名并入 extraVisionModels')
  ok(joined.includes('- 运营商A/DeepSeek-V4-Flash-Vision-Exp'), '运营商变体并入 extraVisionModels')
  ok(joined.includes('- Gemini'), '既有项保序保留')
  const idxGemini = joined.indexOf('- Gemini')
  const idxOfficial = joined.indexOf('- DeepSeek-V4-Flash-Vision-Exp')
  ok(idxGemini !== -1 && idxOfficial !== -1 && idxGemini < idxOfficial, '既有项在前、新增在后')
  ok(r.variants.includes('deepseek-ai/DeepSeek-V4-Flash-Vision-Exp') && r.variants.includes('运营商A/DeepSeek-V4-Flash-Vision-Exp'), 'variants 返回完整')
  // 幂等：再跑一次零变更
  const r2 = vetNativeVisionSettingsText(r.text)
  ok(r2.changed.length === 0, `二次执行零变更（${r2.changed.length}）`)
  ok(r2.text === r.text, '二次执行原文不变')
}

// ── 5. vetNativeVisionSettingsText：键缺失时插入 ─────────────────────────
console.log('5) vetNativeVisionSettingsText（extraVisionModels 缺失）')
{
  const r = vetNativeVisionSettingsText(SETTINGS_BEFORE.replace(/  extraVisionModels:[\s\S]*?  providers:/, '  providers:'))
  const joined = r.text
  ok(joined.includes('extraVisionModels:'), '缺键时插入 extraVisionModels')
  ok(joined.includes('- DeepSeek-V4-Flash-Vision-Exp'), '插入含官方名')
  ok(joined.includes('- 运营商A/DeepSeek-V4-Flash-Vision-Exp'), '插入含运营商变体')
}

// ── 6. 零匹配时不动 ───────────────────────────────────────────────────────
console.log('6) vetNativeVisionSettingsText（无 Flash-Vision 变体 → 零变更）')
{
  // 官方名已在 extraVisionModels、且 models 目录无变体 → 幂等零变更。
  const withOfficial = SETTINGS_BEFORE
    .replace(/- id: deepseek-ai\/DeepSeek-V4-Flash-Vision-Exp\n/, '')
    .replace(/- id: 运营商A\/DeepSeek-V4-Flash-Vision-Exp\n/, '')
    .replace('    - Gemini\n', '    - Gemini\n    - DeepSeek-V4-Flash-Vision-Exp\n')
  const r = vetNativeVisionSettingsText(withOfficial)
  ok(r.changed.length === 0, `官方名已声明且无变体 → 零变更（${r.changed.length}）`)
}
{
  // 变体缺失但官方名不在 extraVisionModels → 仅并入官方名，不碰 models 目录。
  const noVision = SETTINGS_BEFORE
    .replace(/- id: deepseek-ai\/DeepSeek-V4-Flash-Vision-Exp\n/, '')
    .replace(/- id: 运营商A\/DeepSeek-V4-Flash-Vision-Exp\n/, '')
  const r = vetNativeVisionSettingsText(noVision)
  ok(
    r.changed.length === 1 && r.changed[0].includes('extraVisionModels'),
    `仅官方名并入 extraVisionModels（不碰 models 目录）（${r.changed.join(' | ') || '空'}）`,
  )
}

// ── 7. 真实宿主 dry-run ──────────────────────────────────────────────────
console.log('7) 真实宿主 dry-run（不打盘）')
try {
  const HOST = 'D:\\dsh\\resources\\app\\node_modules\\@deepseek-ai\\dsh-host-apiproxy\\lib\\index.js'
  const src = readFileSync(HOST, 'utf8')
  const first = patchApiproxySource(src)
  ok(first.status === 'patched' || first.status === 'already', `真实宿主 patch → ${first.status}`)
  if (first.status !== 'already') {
    ok(first.src.includes('isDshImageOutputFixNativeVision(current.model)'), '真实宿主调用点豁免')
    ok(first.src.includes('function isDshImageOutputFixNativeVision(model) {'), '真实宿主探测函数')
    const again = patchApiproxySource(first.src)
    ok(again.status === 'already' && again.src === first.src, '真实宿主幂等')
    // 语法校验（临时文件，验证后删除）
    const { writeFileSync, rmSync } = await import('node:fs')
    const tmp = HOST.replace('index.js', 'index.v6test.mjs')
    writeFileSync(tmp, first.src, 'utf8')
    const { spawnSync } = await import('node:child_process')
    const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 20000 })
    ok(check.error === undefined && check.status === 0, `真实宿主注入后语法合法（${check.error ? check.error.message : 'ok'}）`)
    rmSync(tmp, { force: true })
  }
} catch (e) {
  ok(false, `真实宿主 dry-run 异常：${e && e.message}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)