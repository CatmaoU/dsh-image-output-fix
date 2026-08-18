# dsh-image-output-fix

修复 DSH 中「发图时报 `pi-ai model "…" does not support image input`」与早期「粘贴图片被自动转述成 `[图片1] 内容…` 文本」两类问题，让图片发送链路按**模型能力**自动分流。

**v0.3.0** 的核心改动：把 `dsh-host-apiproxy` 的 `describeImagesWithVision` 函数体整体替换为「有条件识图转述」。你的识图配置（`dsh-vision.model`，如 `aliyun/qwen3.7-flash`）这次真的会被调用。

## 问题链路（为什么 v0.2.0 会报错）

DSH 收到带图片的 prompt 时，`dsh-host-apiproxy`（约 2908 行起）会先按会话当前模型的能力分流：

```
resolveModelInfo(provider, model).inputModalities 含 image
  → 是：图片原样直发，模型原生看图（无需本插件）
  → 否：调用 describeImagesWithVision(ctx, content) 把图片转述为文字
         ├─ 返回转述文本 → 文本消息发给模型（模型可正常回复）
         └─ 返回 null → 图片原样直发 → llm-pi-ai stream() 层硬校验
              `pi-ai model "deepseek-v4-flash-0731" does not support image input`
              （packages/llm/llm-pi-ai/src/adapter.ts:303-305）→ 本轮运行失败
```

历史版本在 helper 首行注入短路返回，破坏了这个分流：

| 版本 | 注入 | 后果 |
|---|---|---|
| v0.1.0 | `return null;` | `durablePromptContent(ctx, null)` 抛 TypeError → `prompt rejected (agent-busy)`，发图即失败 |
| v0.2.0 | `return content;` | 图片原样透传进消息轮（本意交给 dsh-vision-router 改写），但**转述逻辑被短路**，模型又不支持图片 → pi-ai 直接拒绝，本轮失败；你配置的识图模型根本不会被调用 |
| **v0.3.0** | **替换整个函数体为条件转述** | 模型不支持图片 → 用识别模型转述为文字；支持图片 → 不进入本函数，图片直发 |

## v0.3.0 行为

- **对话模型不支持图片输入**（如 `aliyun/deepseek-v4-flash-0731`，input 仅 `[text]`）：读到 `settings.yaml` 的 `dsh-vision` 段（`baseURL` + `model` + `apiKey`），调识图服务（如 `aliyun/qwen3.7-flash`）逐图并行转述，图片块替换为 `[图片N] <详尽描述>` 文本再发送 —— 不再报错，模型能正常回答图片内容。
- **对话模型支持图片输入**（如 `aliyun/qwen3.7-flash`）：调用点按 `inputModalities` 直接透传图片，本函数不进入，模型原生看图。
- **未配置识图服务 / `autoDescribe: false`**：返回 `null`，调用点回退为图片原样直发（此时若模型不支持图片，错误会由模型侧自然暴露，见下方 FAQ）。

## 特性

- **三处运行副本全覆盖**：`~/.dsh/profiles/node_modules`、`D:\dsh\resources\app\node_modules`、`%APPDATA%\DSH Desktop\agent\node_modules`（含 junction 去重）。
- **函数体整体替换，幂等**：对 v0.1.0 / v0.2.0 的短路注入直接覆盖，不含历史残留 marker。
- **安全**：写盘前 `node --check` 语法校验，失败不写入；首次修改生成 `<文件>.dsh-image-output-fix-prebak` 备份。
- **自动提示**：apply 时检测 `settings.yaml` 的 `dsh-vision.autoDescribe`，为 `false` 时在 `~/.dsh/logs/image-output-fix.log` 输出指引。
- **可离线重跑**：`npm run patch-run`（`scripts/patch-run.mjs`，dry 模式仅校验不写盘，write 模式备份后写盘）。

## 安装

1. 将整个 `dsh-image-output-fix` 目录放入 DSH 插件目录（如 `C:\Users\iMuli\Documents\deepseek\dsh插件`）。
2. 在 DSH 插件清单/配置中启用（参照其他 `cordis.patch.yml` 插件；或 `dsh plugin --profile web add github:CatmaoU/dsh-image-output-fix`）。
3. **重启 DSH**：插件的 `apply` 会在启动时完成磁盘补丁，重启后生效（进程内已加载的旧函数不会热替换）。

## 验证

- 向**不支持图片的模型**（如 `aliyun/deepseek-v4-flash-0731`）发一张图片：应不再报 `does not support image input`，助手能根据识别结果回答。
- 向**支持图片的模型**（如 `aliyun/qwen3.7-flash`）发图：图片原样直发，模型原生看图。
- 日志：`~/.dsh/logs/image-output-fix.log` 应显示三个副本 `✔ 已替换为 v3 有条件识图转述`。

## FAQ

**Q：还是报 `does not support image input`？**
检查 `settings.yaml`：

```yaml
dsh-vision:
  autoDescribe: true   # false 时不会自动转述，图片原样直发
  baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
  model: qwen3.7-flash
  apiKey: sk-...
```

满足「有 `baseURL` + `model`」且 `autoDescribe` 非 `false` 即会转述。若不想自动转述，请把对话模型切到支持图片的模型。

**Q：转述后消息里看不到原图？**
这是 DSH 的既有行为：模型不支持图片时，核心本就会在发送前转述为文字（本插件只是让转述真正执行而不是短路崩溃）。想保留原图直发，把会话模型切换为 `inputModalities` 含 `image` 的模型。

**Q：转述失败会怎样？**
识图服务返回非 2xx 或无有效描述时抛出异常，由宿主调用点按原有逻辑处理（错误提示会注明 HTTP 状态，便于排查 apiKey / 网络 / 额度）。

## License

MIT