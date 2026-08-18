# dsh-image-output-fix

修复 DSH Desktop 中「Ctrl+V 粘贴图片并发送后，图片被转成 `[图片1] 内容…，描述…` 文本」的 bug。

**v0.2.0 起与 [dsh-vision-router](https://github.com/ysr666/dsh-vision-router) 深度集成**：图片不再被核心自动转述，而是原样透传进消息轮，由 dsh-vision-router 接管识图（模型通过 `vision_describe` / `vision_ground` 等工具看图）。插件启动时会检查 dsh-vision-router 是否已安装，未安装则**自动安装**它作为前置。

## 根因

DSH Desktop 的 `main.js` 会向多份 `@deepseek-ai/dsh-host-apiproxy/lib/index.js` 注入图片自动转述逻辑：

- 当用户发送图片、且当前模型不支持图片输入时，核心会调用 `describeImagesWithVision()`；
- 该函数读取 `dsh-vision`（识图插件）配置，调用 VLM 把图片转述成详细文字，并用 `[图片N] …` 替换原图片后再发给模型；
- 你看到的“图片被视觉 AI 解读成文本”并不是你想发送的内容，而是核心发送前的自动替换。

更重要的是：即使 `settings.yaml` 里已经写了：

```yaml
dsh-vision:
  autoDescribe: false
```

某些已存在副本仍是**旧版 helper**，不读取 `autoDescribe` 开关，所以官方 kill switch 也拦不住。这正是本机 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js` 中出现的情况。

## v0.1.0 的坑（已在本版本修复）

v0.1.0 通过在 `describeImagesWithVision` 首行注入 `return null` 来禁用核心转述，但这会触发宿主另一处崩溃：`durablePromptContent(ctx, null)` 对 null 做遍历时抛 TypeError，被外层 catch 包成 **`prompt rejected (agent-busy)`**，导致“发图就失败”。

v0.2.0 改为注入 `return content` —— 图片块原样透传进消息轮，由 dsh-vision-router 的 pre-step hook 记录图片、挂载视觉工具、注入识图提醒，其 wrapper adapter 在模型输入层把图片改写成可见标记，模型再通过工具完成识图：

```
用户发图 → 宿主检测到模型不支持图片 → describeImagesWithVision 被调用
→ （本插件注入）直接 return content → 图片存为 attachment 进消息轮
→ dsh-vision-router pre-step 记录图片 + 挂载视觉工具 + 注入提醒
→ wrapper adapter（deepseek-vision）在模型输入层改写图片块为标记
→ 模型调用 vision_describe / vision_ground 等完成识图
```

## 特性

- **图片透传**：注入 `return content`，图片附件原样进入消息轮，不转述成文本。
- **前置自动安装**：apply 时检测 dsh-vision-router；未安装则后台执行 `dsh plugin --profile <web> add dsh-vision-router`（可用 `DSH_IMAGE_OUTPUT_FIX_NO_AUTO_INSTALL=1` 关闭）。
- **旧补丁自动迁移**：检测到 v0.1.0 留下的 `return null` 补丁，原地迁移为 `return content`。
- 校验修复 `DSH_HOME` 双重拼接（`DSH_HOME` 本已是 dsh 根目录，不应再拼 `.dsh`）与 `%APPDATA%\DSH Desktop\agent` 副本漏扫，确保所有运行副本都被覆盖。
- 幂等：已有修复标记的文件会跳过。
- 安全：写盘前 `node --check` 语法校验，失败不写入。
- 可回滚：首次修改会生成 `<文件>.dsh-image-output-fix-prebak` 备份。
- 日志：`~/.dsh/logs/image-output-fix.log`。

## 安装

1. 将整个 `dsh-image-output-fix` 目录放入你的 DSH 插件目录（例如 `C:\Users\iMuli\Documents\deepseek\dsh插件`）。
2. 在 DSH 插件清单/配置中启用该插件（参照其他 `cordis.patch.yml` 插件）。
3. **重启 DSH Desktop**，插件会在启动时完成磁盘补丁；若未安装 dsh-vision-router，会自动安装并按提示重启。

> 注意：若插件启动时 DSH 核心模块已经加载，磁盘修改在本次进程内不会热替换内存函数，请重启 DSH 后再测试粘贴图片发送。

## 验证

重新粘贴图片发送，消息应保留图片本身，聊天界面上不再出现 `[图片1] …` 自动转述文本，模型会通过 `vision_describe` 等 dsh-vision-router 工具完成识图。

## License

MIT