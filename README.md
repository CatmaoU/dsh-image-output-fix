# dsh-image-output-fix

修复 DSH 中「发图时报 `pi-ai model "…" does not support image input`」问题，让图片按你期望的链路走：

**发图 → 图片原样发送成功（不被转述成文本、界面保留原图）→ dsh-vision-router 的视觉链（Vision Router 里选的识别模型，如 `aliyun/qwen3.7-flash`）识图 → 当前对话模型（如 `aliyun/deepseek-v4-flash-0731`）组织回答。**

**v0.4.0** 的核心改动：把 `dsh-host-apiproxy` 的 `describeImagesWithVision` 函数体整体替换为**透传（return content）**，并把 `settings.yaml` 的 `vision-router.routing` 修正为 `true` —— 图片由 vision-router 视觉链接管识别，不再由 apiproxy 侧的转述短路掉。

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
- Vision Router 日志/路由：图片轮应切到 `vision-chain`（识别模型 `aliyun/qwen3.7-flash`），文本轮保持在 `aliyun/deepseek-v4-flash-0731`。
- 日志：`~/.dsh/logs/image-output-fix.log` 应显示副本 `✔ 已替换为 v4 图片透传` 与 settings 修正记录。

## FAQ

**Q：还是报 `does not support image input`？**
1. 重启过 DSH 吗？（进程内旧函数不会热替换）
2. `settings.yaml` 的 `vision-router.routing` 是否为 `true`？（apply 会修；手工改也行）
3. `vision-router.providers` 是否配置了识别模型（如 `aliyun/qwen3.7-flash`）？图片轮会切到它的视觉链。

**Q：图片发出去但助手答不上来？**
视觉链未命中：确认 Vision Router 设置（providers / textProvider / routing），以及 **`ALIYUN_API_KEY` 凭据是否在 DSH 模型设置页保存**（不是 settings.yaml 明文）。识别失败的错误会从视觉链自然暴露。

**Q：为什么 v4 不做转述？**
转述（v3）会把你的图片替换成文本块，转录里丢失原图。`routing: true` 后视觉链在模型输入层完成识别，消息历史仍保留图片附件。

## License

MIT