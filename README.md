# dsh-image-output-fix

修复 DSH 中「发图时报 `pi-ai model "…" does not support image input`」问题，让图片按你期望的链路走：

**发图 → 图片原样发送成功（不被转述成文本、界面保留原图）→ dsh-vision-router 的视觉链（Vision Router 里选的识别模型，如 `aliyun/qwen3.7-flash`）识图 → 当前对话模型（如 `aliyun/deepseek-v4-flash-0731`）组织回答。**

**v0.4.0** 的核心改动：把 `dsh-host-apiproxy` 的 `describeImagesWithVision` 函数体整体替换为**透传（return content）**，并把 `settings.yaml` 的 `vision-router.routing` 修正为 `true` —— 图片由 vision-router 视觉链接管识别，不再由 apiproxy 侧的转述短路掉。

**v0.5.0** 的核心改动：settings.yaml **幂等自愈**（行级文本处理，零 YAML 依赖）。针对阿里云免费额度耗尽（403）与请求 hang 饿死视觉链的问题，启动时对 settings.yaml 做四处收敛，并把硅基流动（SiliconFlow）的 Qwen3-VL-32B-Instruct 作为视觉兜底链置于 aliyun 之前：

- `vision-router.providers`：缺 `siliconflow` / `Qwen/Qwen3-VL-32B-Instruct` 则补到链首；若它在 aliyun 之后则重排为 `[siliconflow, aliyun, …其余保序]`。
- `vision-router.visionTaskTimeoutMs`：缺失或 < 120000 时兜底为 120000（用户更大值如 180000 不动）。整链共享 wall-clock 预算，aliyun 请求 hang 会把兜底饿死，放宽预算让超时 abort 失效后端而不是饿死后续后端。
- `vision-router.rewriteImages` / `dsh-vision.cache`：遇 `false` 收敛为 `true`，防历史图片块反复触发重新识图、烧视觉额度。
- `llm-pi-ai.providers.siliconflow.models`：保证 `Qwen/Qwen3-VL-32B-Instruct` 存在且带 `name` / `input: [text, image]` 声明（缺失则补行）。

**v0.6.0** 的核心改动：支持**官方原生视觉模型 DeepSeek-V4-Flash-Vision-Exp**（及第三方渠道同名/变体模型，如 `xxx运营商/DeepSeek-V4-Flash-Vision-Exp`）。这类模型本身能看图，DSH ≥ 0.1.1-rc.1 已支持**原生图片导入**，所以**不再转述**：

- **宿主调用点豁免（v5 补丁）**：在 `describeImagesWithVision` 的调用点注入 `isDshImageOutputFixNativeVision(current.model)` 判断——会话模型名同时含 `flash` + `vision`（大小写不敏感，排除 embedding/reranker）时，跳过转述分支，图片以 durable attachment **原生进消息轮**，模型直接看图（省掉一次「图片 → 文本」转述的 token）。`DeepSeek-V4-Flash` 等纯文本模型行为不变：仍透传 + vision-router 视觉链转述。
- **settings.yaml 自动声明**：
  - `llm-pi-ai.providers.*.models`：为名称命中的条目补 `input: [ text, image ]`（第三方渠道据此放行多模态请求，宿主也据此判定模型支持图片）。
  - `vision-router.extraVisionModels`：自动合并 `DeepSeek-V4-Flash-Vision-Exp` + 扫描到的全部变体（去重保序、幂等），vision-router 据此强制认定这些模型具备视觉能力，不再把它们的图片轮切走/改写成文本。

## 问题链路（为什么 v0.1.0 ~ v0.3.0 都不对）

DSH 收到带图片的 prompt 时，`dsh-host-apiproxy`（约 2908 行起）先按会话当前模型能力分流：

```
resolveModelInfo(provider, model).inputModalities 含 image
  → 是：图片原样直发，模型原生看图（无需本插件）
  → 否：调用 describeImagesWithVision(ctx, content)【本插件替换点】
```

| 版本 | 注入 | 后果 |
|---|---|---|
| v0.1.0 | `return null;` | `durablePromptContent(ctx, null)` 抛 TypeError → `prompt rejected (agent-busy)`，发图即失败 |
| v0.2.0 | `return content;`（透传） | 本意交给 dsh-vision-router 改写，但本机 `routing: false` → `agent/request` 不改路由，图片轮仍由纯文本模型接收 → pi-ai 硬拒 `does not support image input`，识图模型永不参与 |
| v0.3.0 | 整个函数体替换为「有条件转述」 | 不再报错，但你配置的识别模型把图片转述成 `[图片N] 长篇描述` 文本**替换进用户消息**——转录里看不到原图，体验不可接受 |
| **v0.4.0** | **透传 + 修正 `vision-router.routing: true`** | 图片原样进入消息轮、界面保留原图；图片轮由 vision-router 视觉链切到识别模型（如 `aliyun/qwen3.7-flash`）；文本轮由 `reverseRouting` 切回 `textProvider`（如 `aliyun/deepseek-v4-flash-0731`） |

## v0.4.0 行为

- **helper 只做透传**：`return content;` —— 图片以 durable attachment 进入消息轮，界面显示原图。
- **settings.yaml 自动修正**：apply 时把 `vision-router.routing: false → true`（图片轮交由视觉链接管）、`dsh-vision.autoDescribe: true → false`（还原，v4 不再依赖自动转述）。设置 `DSH_IMAGE_OUTPUT_FIX_NO_SETTINGS=1` 可豁免。
- **前提**：Vision Router 设置里 `providers` 已选识别模型（如 `aliyun/qwen3.7-flash`）、`textProvider` 为当前对话模型（如 `aliyun/deepseek-v4-flash-0731`）。本插件只保证图片不触发 pi-ai 硬拒，路由由 vision-router 完成。

## v0.5.0 自愈细节

- **为什么需要硅基流动兜底**：阿里云百炼免费额度耗尽会 403（`AllocationQuota.FreeTierOnly`），且付费生效前请求会 hang——vision-router 整链共享 wall-clock 预算（默认 45000ms），aliyun 挂起会耗尽预算把后续兜底饿死。硅基流动的 `Qwen/Qwen3-VL-32B-Instruct` 实测可正常识图，作为链首兜底。
- **幂等**：对已合规的 settings.yaml **逐字节零改动**（测试用例保证）。行级处理不引入 YAML 序列化风险，任何一轮修复都只增删确定的行。
- **防御重复烧额度**：`rewriteImages: true` + `cache: true` 后，历史图片块会被替换为「缓存描述 / 附件标记」而非重新识图；注意 imageMemory 是 vision-router 进程内 Map，DSH 重启即清空，重启后的新一轮会话仍可能重新识图（属平台行为）。

## v0.6.0 原生视觉模型（DeepSeek-V4-Flash-Vision-Exp）

**背景**：官方新模型 `DeepSeek-V4-Flash-Vision-Exp` 原生支持图片输入；DSH ≥ 0.1.1-rc.1 支持原生图片导入（模型目录声明 `image` 能力后图片直接以多模态块发给模型）。此时若再经 vision-router 转述一遍（图片 → 文本）就是**双重处理、浪费 token**。

**判定规则**（`isDshImageOutputFixNativeVision`，插件注入/导出，两处共用同一规则）：

- 模型名同时包含单词 `flash` 与 `vision`（大小写不敏感）→ 原生视觉。覆盖官方名与任意第三方渠道变体：
  - `DeepSeek-V4-Flash-Vision-Exp`
  - `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp`
  - `xxx运营商/DeepSeek-V4-Flash-Vision-Exp`、`DeepSeek-V4-Flash-Vision-Exp-xxx`
- 名字含 `embedding` / `rerank` 等词 → 排除（向量端点不是生成模型）。
- `DeepSeek-V4-Flash` / `deepseek-v4-pro` 等 → 不命中，保持转述链路（当且仅当纯文本模型不存在图片能力时）。

**v5 宿主补丁（三件套，幂等）**：

1. **调用点豁免**：`if (... && !isDshImageOutputFixNativeVision(current.model))` —— 原生视觉模型跳过 `describeImagesWithVision`，图片原生进消息轮。
2. **helper 仍透传**：`return content;`（只被真·纯文本模型走到，交给 vision-router 视觉链）。
3. **注入探测函数**：模块级 `isDshImageOutputFixNativeVision(model)`，与插件内 `lib/index.js` 的判定规则一致。

**settings 自愈（幂等）**：

- `llm-pi-ai.providers.*.models`：命中 Flash-Vision 的条目自动补 `input: [ text, image ]`（已有则不动）。
- `vision-router.extraVisionModels`：自动合并官方名 + 扫描到的变体（既有项保序在前、新增在后、幂等）。vision-router 据此强制认定这些模型具备视觉能力，图片轮不再被切到视觉链或改写成文本。

**已知边界**：vision-router 1.6.x 的 `agent/request` 层 legacy routing（`routing: true`）对含图轮是**无条件切链**的，且其 stealth 包装在无 `preserveImageInput` 时会改写图片块——这些行为不由本插件控制。本插件保证：宿主侧对原生视觉模型不再转述 + settings 声明让各层（含 vision-router 未来版本）识别其为视觉模型。若仍观察到图片轮被切走，请升级/配置 vision-router 的 `extraVisionModels`（本插件已自动写入）。

## 验证（v0.5.0 自增检查）

- 日志 `~/.dsh/logs/image-output-fix.log` 显示 `✓ settings.yaml 已符合 v0.5.0 要求`。
- 对已合规配置重跑 `npm run patch-run`（dry）零改动。
- 手改退化：把 providers 顺序颠倒、timeout 删掉、cache 改 false——重启后插件自动收敛回合规态。

## 凭据来源（v0.4.x 不读取明文 apiKey）

识别模型的鉴权**完全交给 DSH 框架**：视觉链经 llm-pi-ai 的 credentials service 解析 `ALIYUN_API_KEY`（在「设置 → Models/模型设置」里保存后写入 `~/.dsh/.credentials.yaml`）。

- 本插件源码**不含任何** `apiKey` 读取、`Authorization` 构造或网络请求逻辑（`grep apiKey|fetch(` 零匹配）。
- `settings.yaml` 里 `dsh-vision.apiKey` 的明文只是 v0.3.0 时代的遗留参考，**v0.4.x 完全不读取**；即使该 key 已失效也不影响视觉链，可放心删除。
- 启动日志会输出凭据诊断：`✓ 识别凭据 ALIYUN_API_KEY 已配置…` 或 `⚠ 未检测到凭据…`（见 `~/.dsh/logs/image-output-fix.log`）。

## 特性

- **三处运行副本全覆盖**：`~/.dsh/profiles/node_modules`、`D:\dsh\resources\app\node_modules`、`%APPDATA%\DSH Desktop\agent\node_modules`（含 junction 去重，profiles 副本物理上指向 agent 目录者只写一份）。
- **函数体整体替换，幂等**：对 v0.1.0 / v0.2.0 / v0.3.0 的注入直接覆盖，不含历史残留 marker。
- **安全**：写盘前 `node --check` 语法校验，失败不写入；首次修改生成 `<文件>.dsh-image-output-fix-prebak` 备份；settings 修正前生成 `settings.yaml.dsh-image-output-fix-bak` 备份。
- **可离线重跑**：`npm run patch-run`（dry 模式仅校验不写盘，write 模式备份后写盘）。

## 安装

1. 将整个 `dsh-image-output-fix` 目录放入 DSH 插件目录（如 `C:\Users\iMuli\Documents\deepseek\dsh插件`）。
2. 在 DSH 插件清单/配置中启用（参照其他 `cordis.patch.yml` 插件；或 `dsh plugin --profile web add github:CatmaoU/dsh-image-output-fix`）。
3. **重启 DSH**：插件的 `apply` 会在启动时完成磁盘补丁与 settings 修正，重启后生效（进程内已加载的旧函数不会热替换）。

## 验证

- 向纯文本模型（如 `aliyun/deepseek-v4-flash-0731`）发一张图片：应不再报 `does not support image input`；消息气泡保留你的原图；助手基于图片识别结果回答。
- 切换到 `DeepSeek-V4-Flash-Vision-Exp` 后发图：图片原生进入消息轮、**不经过任何转述**（日志应显示 `✓ 原生视觉模型识别：DeepSeek-V4-Flash-Vision-Exp…`，settings 中该模型出现在 `extraVisionModels` 且 models 目录带 `input: [ text, image ]`）。
- Vision Router 日志/路由：纯文本模型图片轮应切到 `vision-chain`（识别模型 `aliyun/qwen3.7-flash`），文本轮保持在 `aliyun/deepseek-v4-flash-0731`。
- 日志：`~/.dsh/logs/image-output-fix.log` 应显示副本 `✔ 已替换为 v5` 与 settings 修正记录。

## FAQ

**Q：还是报 `does not support image input`？**
1. 重启过 DSH 吗？（进程内旧函数不会热替换）
2. `settings.yaml` 的 `vision-router.routing` 是否为 `true`？（apply 会修；手工改也行）
3. `vision-router.providers` 是否配置了识别模型（如 `aliyun/qwen3.7-flash`）？图片轮会切到它的视觉链。

**Q：用 DeepSeek-V4-Flash-Vision-Exp 发图还被转述/切链？**
1. 确认该模型在 `vision-router.extraVisionModels` 里（v0.6.0 apply 会自动写入；含第三方变体也一样命中）。
2. 确认 `llm-pi-ai.providers.*.models` 中该模型带 `input: [ text, image ]` 声明（v0.6.0 自动补）。
3. 若你的 vision-router 版本 legacy routing 对图片轮无条件切链（1.6.x 行为），升级 vision-router 或关闭 `routing` 改用 wrapper/rewrite 模式。

**Q：什么情况下会走转述？**
只有当会话模型**既不声明图片输入、名字也不命中原生视觉探测**时才转述（如 `DeepSeek-V4-Flash`）。转述链路 = 图片透传进消息轮 → vision-router 视觉链识别 → 纯文本模型基于识别结果回答。

**Q：图片发出去但助手答不上来？**
视觉链未命中：确认 Vision Router 设置（providers / textProvider / routing），以及 **`ALIYUN_API_KEY` 凭据是否在 DSH 模型设置页保存**（不是 settings.yaml 明文）。识别失败的错误会从视觉链自然暴露。

**Q：为什么 v4 不做转述？**
转述（v3）会把你的图片替换成文本块，转录里丢失原图。`routing: true` 后视觉链在模型输入层完成识别，消息历史仍保留图片附件。v0.6.0 更进一步：原生视觉模型连转述都不需要。

## License

MIT