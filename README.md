# cmchen-u-agent · U 盘便携 AI Agent

> 插上 U 盘，双击即用。把一个带文件操作、命令执行、联网搜索、git、子 agent 的 AI 助手装进口袋。

把本目录放进 U 盘，插上任意 **Windows 10/11 x64** 电脑：双击 `启动U-Agent.bat`，浏览器自动打开本地聊天页，agent 就能操作那台电脑上的文件。所有环境、配置、会话数据全部留在 U 盘目录内——宿主机**零安装、零配置、零残留**，拔盘即走。

## 三步用法

1. **装环境（只做一次）**：双击 `setup-uagent.bat`（需联网，约 1 分钟，自动从 npmmirror 下载便携版 node 22）
2. **首次配置（只做一次）**：双击 `启动U-Agent.bat` → 浏览器打开后点右上角「设置」→ 选工作区目录、选模型并填 API key（保存在 U 盘里，以后永不再配）
3. **日常使用**：插 U 盘 → 双击 `启动U-Agent.bat` → 开聊。换任何电脑都不用重装重配

模型走 OpenAI 兼容接口，内置三协议：**OpenAI Chat Completions / OpenAI Responses / Anthropic Messages**（GLM、DeepSeek、OpenAI、Anthropic 预填好，改 key 即用）；没配 key 也能用 **Mock 模式**体验界面。

## 能力

| 能力 | 说明 |
|---|---|
| 文件 | 列/读/写/局部改/搜索/移动/建目录/删除（删除与覆盖高危） |
| 命令 | cmd 执行（30 秒超时、输出截断、破坏系统命令无条件拒绝） |
| git | status / diff / log / commit / push / pull（在工作区仓库上） |
| 联网 | web_search（Tavily/Brave 配 key 优先，DuckDuckGo 兜底）+ web_fetch 网页转文本 |
| 子 agent | spawn_subagent 派生独立子任务，网页里嵌套展示 |
| 多模态 | 对话框直接粘贴/拖入图片提问 |
| 权限五档 | 确认（默认，高危弹窗）· 只读 · 计划 · 自动审批（高危直接拦截）· 完全权限 |
| 记忆 | 会话 JSONL 追加日志全存 U 盘 `data\sessions\` |

安全设计：路径沙箱（只允许工作区与 U 盘目录，越界拒绝）、高危操作审批、shell 黑名单（format/shutdown/reg delete 等任何模式都拦）、审计日志。

## 原理与结构

`node.exe`（便携，U 盘内）+ **零 npm 依赖**的 Node 脚本（只用内置模块，FAT32 U 盘免安装免编译）。内核设计参考 [deepseek-ai/deepseek-harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的「Agent = Model + Harness、一切皆插件、工具风险审批、会话追加日志」；U 盘打包模式参考 [hermes-portable](https://github.com/yuluyangguang1/hermes-portable)、[portable-agent-usb](https://github.com/bnovik0v/portable-agent-usb) 等同类项目。

```
启动U-Agent.bat   双击入口（%~dp0 相对定位，换盘符免改）
setup-uagent.bat  环境安装（幂等，--force 重装）
launcher.mjs      空闲端口探测(3080→3090) + 起服务 + 开浏览器
server.mjs        本地服务（只绑 127.0.0.1）
core/             主循环·三协议适配·模式门禁·沙箱·确认闸·会话
tools/            19 个插件工具（fs/shell/git/web/subagent）
public/           单文件网页界面
runtime|data|config.json   运行时与数据（不进 git）
```

## 测试

`runtime\node\node.exe --test test/*.test.mjs` —— 37 个用例：三协议流解析、沙箱越界、五档门禁、确认闸、fs/git/shell/web 工具、服务器端到端（含图片与模式拦截）。

## 已知限制

- 目标机需能访问所选模型 API（联网）；Mock 模式离线可用
- 目标机使用 git 工具需其装有 git；API key 明文存 U 盘 `data\credentials.json`（U 盘别外借）
- shell 30 秒超时、输出 200KB 截断；只支持 Win10/11 x64

## License

MIT © 2026 cmchen（[shi-tou1234](https://github.com/shi-tou1234)）。感谢 DeepSeek Harness（MIT）与各便携打包项目的开源贡献。
