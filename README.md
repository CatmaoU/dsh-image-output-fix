# dsh-image-output-fix

修复 DSH Desktop 中「Ctrl+V 粘贴图片并发送后，图片被转成 `[图片1] 内容…，描述…` 文本」的 bug。

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

## 修复方式

插件启动时扫描所有已知 `dsh-host-apiproxy/lib/index.js` 副本，在 `describeImagesWithVision` 函数体最前面注入：

```js
return null;
```

从而**从根本上禁用核心自动转述**。用户图片将作为图片附件原样发送，识图工作交给 `dsh-vision` 的 `view_image` 工具、Vision Router 或其他插件按需完成。

## 特性

- 幂等：已有修复标记的文件会跳过。
- 安全：写盘前 `node --check` 语法校验，失败不写入。
- 可回滚：首次修改会生成 `<文件>.dsh-image-output-fix-prebak` 备份。
- 覆盖三处官方运行副本：用户 profile / Desktop app 目录 / userData agent 目录。
- 日志：`~/.dsh/logs/image-output-fix.log`。

## 安装

1. 将整个 `dsh-image-output-fix` 目录放入你的 DSH 插件目录（例如 `C:\Users\iMuli\Documents\deepseek\dsh插件`）。
2. 在 DSH 插件清单/配置中启用该插件（参照其他 `cordis.patch.yml` 插件）。
3. **重启 DSH Desktop**，插件会在启动时完成磁盘补丁。

> 注意：若插件启动时 DSH 核心模块已经加载，磁盘修改在本次进程内不会热替换内存函数，请重启 DSH 后再测试粘贴图片发送。

## 验证

重新粘贴图片发送，消息应保留图片本身，聊天界面上不再出现 `[图片1] …` 自动转述文本。想要识图时，可直接让模型调用 `view_image` 工具，或使用 Vision Router / 其他识图插件。

## License

MIT