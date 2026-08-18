// dsh-image-output-fix v4 patch runner — usage:
//   node scripts/patch-run.mjs dry    （只生成 + 校验补丁文本，不写盘）
//   node scripts/patch-run.mjs write   （校验通过后备份 + 写盘）
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const PLUGIN_URI = 'file:///C:/Users/iMuli/Documents/deepseek/dsh%E6%8F%92%E4%BB%B6/dsh-image-output-fix/lib/index.js'
const { patchApiproxySource, V4_MARKER } = await import(PLUGIN_URI)

const TARGETS = [
  'C:\\Users\\iMuli\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh-host-apiproxy\\lib\\index.js',
  'D:\\dsh\\resources\\app\\node_modules\\@deepseek-ai\\dsh-host-apiproxy\\lib\\index.js',
  'C:\\Users\\iMuli\\AppData\\Roaming\\DSH Desktop\\agent\\node_modules\\@deepseek-ai\\dsh-host-apiproxy\\lib\\index.js',
]

const mode = process.argv[2] || 'dry'
const node = 'C:\\Program Files\\nodejs\\node.exe'
let allOk = true
for (const target of TARGETS) {
  const src = readFileSync(target, 'utf8')
  const result = patchApiproxySource(src)
  if (result.status === 'unknown') { console.log(`UNKNOWN-ANCHOR  ${target}`); allOk = false; continue }
  if (result.status === 'already') { console.log(`ALREADY-V4      ${target}`); continue }
  const tmp = target + '.dsh-image-output-fix-dryrun.mjs'
  writeFileSync(tmp, result.src, 'utf8')
  const check = spawnSync(node, ['--check', tmp], { encoding: 'utf8', timeout: 20000 })
  const hasMarker = result.src.includes(V4_MARKER)
  const hasPass = /return content;/.test(result.src)
  const noV1 = !result.src.includes('keep user images untouched')
  const noV2 = !result.src.includes('passthrough image blocks to dsh-vision-router (v2)')
  const noV3 = !result.src.includes('describeOne') && !result.src.includes('image_url') && !result.src.includes('autoDescribe === false')
  const ok = check.status === 0 && hasMarker && hasPass && noV1 && noV2 && noV3
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${target}`)
  console.log(`      status=${result.status} bytes=${result.src.length} syntax=${check.status === 0 ? 'PASS' : 'FAIL ' + ((check.stderr || check.stdout || '').split('\n').slice(0, 4).join(' | '))} markerV4=${hasMarker} passthrough=${hasPass} v1clean=${noV1} v2clean=${noV2} v3clean=${noV3}`)
  if (ok && mode === 'write') {
    const bak = target + '.dsh-image-output-fix-prebak'
    if (!existsSync(bak)) copyFileSync(target, bak)
    writeFileSync(target, result.src, 'utf8')
    console.log(`      WROTE (backup: ${existsSync(bak) ? bak : 'n/a'})`)
  }
  rmSync(tmp, { force: true })
  if (!ok) allOk = false
}
console.log(mode === 'write' ? 'WRITE-DONE' : 'DRY-DONE', allOk ? 'ALL-PASS' : 'HAS-FAILURES')
process.exit(allOk ? 0 : 1)