# u-agent · U 盘便携 AI Agent — 设计规格（真源）

一句话：插上 U 盘双击 `启动U-Agent.bat`，任意 Win10/11 x64 电脑的浏览器里出现聊天界面，agent 能操作那台电脑上的文件；第 1 次在网页里配好模型 key 后永久免配置。所有环境、配置、会话数据全部留在 U 盘目录内，宿主机零安装零残留。

架构模式参考（2026-10-11 调研）：GitHub 上同类项目（yuluyangguang1/hermes-portable 59★、bnovik0v/portable-agent-usb、techjarves/ClaudeCode-Portable 等）全部采用「便携运行时 + agent + 启动脚本 + 数据留盘」套路；agent 内核设计参考 deepseek-ai/deepseek-harness（dsh，24.7 万★）的「Agent = Model + Harness、一切皆插件、会话追加日志、工具风险审批」。

## 硬约束

1. **零 npm 依赖**：所有 .mjs 只用 Node 内置模块（node:http、node:fs、node:child_process、node:net、node:test…）。U 盘是 FAT32（无符号链接、小文件写入慢），绝不触发 npm install。
2. **相对定位**：所有路径从启动脚本 %~dp0 推导，禁绝对盘符；整个目录拷到任何盘符/路径都能跑。
3. **数据隔离**：配置/凭证/会话只写 U 盘内 `data/` 与 `config.json`；不许写 %USERPROFILE%、%APPDATA%、%LOCALAPPDATA%（宿主机零残留红线）。
4. 只支持 Windows 10/11 x64。

## 目录布局

```
G:\agent\                     ← 仓库根 = U 盘目录 (github.com/shi-tou1234/cmchen-u-agent)
├── 启动U-Agent.bat            ← 唯一双击入口
├── launcher.mjs              ← 选空闲端口(3080→3090) + spawn server.mjs，转发 stdio
├── setup-uagent.bat          ← 装环境入口（中文提示，失败 pause 不闪退）
├── setup.mjs                 ← 幂等安装便携 node，--force 重装
├── VERSIONS.json             ← {"node":"22.21.1"} 唯一版本真源，setup 读它拼下载 URL
├── server.mjs                ← node:http 服务：静态 public/ + /api/*（SSE 流式）
├── core\agent-loop.mjs       ← 主循环：prompt→模型→tool_calls→risk gate→执行→回填，max_steps=30
├── core\providers.mjs        ← 三协议适配器 + Mock provider
├── core\tools.mjs            ← 工具注册表：扫描 tools/*.mjs 自动加载（一切皆插件）
├── core\sandbox.mjs          ← 路径白名单解析与拒绝
├── core\confirm.mjs          ← 高危操作 pending 表：创建→等网页确认→放行/取消（带超时60s，可附一句话理由）
├── core\checkpoints.mjs      ← 改动前文件快照 + 冲突检测 + 一键回滚（不依赖 git）
├── core\model-windows.mjs    ← 模型能力表：上下文窗口 / 输出上限 / 是否带思考（数据源自 models.dev）
├── core\sessions.mjs         ← 会话 JSONL 追加日志（data/sessions/<id>.jsonl）
├── tools\                    ← 每个工具一个 .mjs，export {name,description,params,risk,run}
├── public\                   ← 网页（index.html + css + js 模块，原生零依赖）
├── test\*.test.mjs           ← node:test 零依赖测试
├── config.example.json       ← 提交进 git；config.json（真实 key）git 忽略
├── data\                     ← settings.json(工作区等) / credentials.json(key) / sessions\（git 忽略）
├── runtime\node\             ← setup 产出的便携 node（git 忽略）
├── README.md / DESIGN.md / LICENSE(MIT) / .gitignore / PROGRESS.md / BLOCKED.md
```

## 模型接入（三协议，领导拍板）

统一内部格式 = OpenAI 风格 messages + tool_calls。config.json 的 providers 数组，每项 `{name, protocol, baseURL, model, apiKey}`；protocol ∈ `openai-chat | openai-responses | anthropic | mock`。apiKey 为空时首启在网页设置抽屉里填，存 data/credentials.json。

| protocol | 请求 | 流式解析要点 |
|---|---|---|
| openai-chat | POST {baseURL}/chat/completions，Authorization: Bearer | SSE `data:` 行，`choices[].delta`，`delta.tool_calls[]` 拼接 |
| openai-responses | POST {baseURL}/responses | SSE 事件 `response.output_text.delta`、`response.output_item.added`(function_call)、`response.completed` |
| anthropic | POST {baseURL}/v1/messages，头 `x-api-key` + `anthropic-version: 2023-06-01` | SSE `content_block_delta`(text/tool_use)、`content_block_start`，tool 结果回传 role=user + tool_result 块 |
| mock | 无网络 | 内置脚本：收到固定指令返回预设 tool_calls 序列，用于离线演示与全部测试 |

默认 providers（config.example.json 预填，model 名按 2026-10 常识）：GLM(openai-chat, https://open.bigmodel.cn/api/paas/v4, glm-4.7)、DeepSeek(openai-chat, https://api.deepseek.com, deepseek-chat)、OpenAI(openai-responses, https://api.openai.com/v1, gpt-5)、Anthropic(anthropic, https://api.anthropic.com, claude-sonnet-4-5)、Mock。

## 工具集（文件 + 受限 Shell，领导拍板）

risk 三档：`low` 直接执行；`medium` 直接执行但记 audit；`high` 必须 confirm（网页弹窗，用户点确认才执行）。

| 工具 | risk | 说明 |
|---|---|---|
| fs_list(path) | low | 列目录 |
| fs_read(path, offset?, limit?) | low | 读文本，默认限 200KB |
| fs_search(query, path?, glob?) | low | 文件名 + 内容搜索 |
| fs_mkdir(path) | medium | 建目录 |
| fs_write(path, content) | new=medium, overwrite=high | 写文件，覆盖已有文件要先确认 |
| fs_edit(path, old, new) | medium | 局部替换，old 必须唯一命中 |
| fs_move(src, dst) | medium | 移动/重命名 |
| fs_delete(path) | high | 删除（进确认） |
| shell_run(command, cwd?) | high | 受限执行，每次都进确认 |
| sys_info() | low | 主机名、盘符、工作区、node 版本 |

shell_run 限制：cwd 必须在白名单内；命令黑名单正则（format、shutdown、reg delete、vssadmin、cipher /w、rd /s 命中盘根、del /s /q 盘根等）；超时 30s 杀进程树；stdout+stderr 截断 200KB。

sandbox：白名单 = [工作区目录（首启网页里选，存 data/settings.json），U 盘目录自身]。所有 fs_* 与 shell cwd 的路径先 resolve 再判定必须落在白名单内，`..` 逃逸一律拒绝；拒绝时返回结构化错误（agent 能看到并向用户解释）。

## 网页（public/，2026-10-12 重构）

**单一职责拆分**（原 855 行单文件，改为 11 个文件，仍零依赖、零 CDN）：

```
public\index.html      骨架：语义标签 + SVG 图标精灵（无样式、无逻辑）
public\css\app.css     设计令牌（明暗两套）+ 组件样式 + 响应式
public\js\ui.js        DOM/转义/Markdown 行式解析/Toast/图标
public\js\api.js       后端接口封装（统一 401 未解锁回调）
public\js\state.js     运行态单一数据源 S + 模式表 + 放行动作表
public\js\catalog.js   模型厂商预设库（24 家，四组；含按模型分协议的网关）
public\js\picker.js    顶栏两个弹出选择器：模型通道、权限模式（+ 状态条模式芯片）
public\js\chat.js      消息流渲染、SSE、工具卡/计划卡、本轮改动卡（含撤销）、高危确认（可附言）、斜杠命令、附件、用量条、导出
public\js\settings.js  设置面板：分类导航 + 分区卡 + 通道卡 + 目录选择 + 添加通道向导 + 自动放行 + 提醒 + 检查点占用
public\js\app.js       启动流程、密码锁、会话侧栏、主题、快捷键
public\js\notify.js    注意力提醒：页面切走时才发系统通知 / 标题闪烁
public\js\theme.js     浅色/深色/跟随系统（存浏览器本地，不写 U 盘数据）
```

界面结构：会话侧栏（新会话/搜索/会话列表/设置入口）+ 顶栏（模型通道、权限模式、主题）+ 消息流（用户气泡右对齐、助手正文含 Markdown/代码块/可折叠工具卡/计划卡/本轮改动卡可一键撤销）+ 输入区（上方一条状态条：权限模式 / 自动放行摘要 / 上下文进度条 / 压缩按钮；内部：附件条、斜杠命令与 @ 提及面板、用量与模式提示）+ 全屏设置面板（左分类导航：通用/模型/权限/记忆/联网/安全/关于；右分区卡；底部「未保存改动」提示条）。

**换机即插即用不受拆分影响**（验收 F/G）：静态资源按扩展名回正确 MIME（.js=text/javascript，否则浏览器拒绝执行 ES module）；页面内引用一律站内相对路径 `/css/...`、`/js/...`，无 CDN、无 npm、无编译产物；9 个静态文件全部在 `public\` 内，FAT32 免符号链接；运行时只读盘内 `runtime\node\node.exe`，数据只写盘内 `data\` 与 `config.json`。浏览器基线：Chrome/Edge 90+（ES module + 可选链；代码里已避开 `.at()` 这类更新 API）。

交互约定（参考 Cherry Studio / Open WebUI / bedrock-engineer 等同类产品）：

- 设置=「左侧分类导航 + 右侧分区卡」，不再一长条堆叠；同类设置收进同一张卡（标题 + 一句说明 + 控件）
- 能用开关/单选卡就不用下拉（权限五档改为带说明的单选卡）
- 每个都有「测试连接」按钮（`POST /api/test-provider`），配错了当场知道
- 显式保存 + 脏标记提示条（不静默改配置），非法输入（重名通道、空列表）在保存前拦下
- 工作区用可视化目录选择器（`GET /api/browse`）而不是手写路径
- 状态条常驻在输入框上方：当前权限、自动放行摘要、上下文占用一眼可见，且都能点（点模式换模式，点压缩就地压缩）
- 模式卡按两列排布、自动放行清单压成单行——设置页不必翻很久才能改完想改的
- UI 文本用系统无衬线字体（中文可读），只有代码用等宽；8px 间距体系 + 焦点环 + 三态（hover/focus/disabled）

后端为网页新增：`GET /api/info`（本机与 U 盘信息）、`GET /api/browse?path=`（只列目录名，不返回文件内容；根列举盘符，过滤 `$RECYCLE`/`System Volume Information`）、`POST /api/test-provider`（用一条极短请求验证地址/协议/钥匙，25s 超时，失败返回上游错误原文）。三者均在密码锁保护范围内（非白名单需解锁）。

## setup 规格

- 读 VERSIONS.json 拼 URL：`https://registry.npmmirror.com/-/binary/node/v{V}/node-v{V}-win-x64.zip`（v22.21.1 = 35,556,042 字节，2026-10-11 已下载验证；nodejs.org 官方源本机不通）
- 下载到 data/cache → 解压整个目录到 runtime\node\ → 删 zip → `runtime\node\node.exe --version` 验证输出 v22.21.1
- 幂等：runtime\node\node.exe 已存在且版本对 → 打印「已就绪」退出，不改任何文件；`setup-uagent.bat force` 删 runtime 重装
- 说明文案提醒：U 盘首次安装约 1-2 分钟（本方案无 npm，远快于旧方案）

## 启动器规格

- 启动U-Agent.bat：`set "UA_HOME=%~dp0"`，检查 runtime\node\node.exe 存在，缺失则中文报错「请先双击 setup-uagent.bat」+ pause；`"%~dp0runtime\node\node.exe" "%~dp0launcher.mjs"`；窗口关 = 进程树停（前台运行，不做服务、不全局 taskkill）
- launcher.mjs：node:net 从 3080 探测到 3090 找空闲口 → spawn server.mjs（传 UA_HOME、UA_PORT）→ 子进程退出则 launcher 退出；服务就绪后 `start http://127.0.0.1:<port>/`
- server.mjs：绑 127.0.0.1（禁 0.0.0.0）

## 验收命令（判卷标准，执行者不许改）

```
A 结构: ls G:/agent 关键文件齐 + cat VERSIONS.json
B 装机: rm -rf G:/agent/runtime && cd G:/agent && ./setup-uagent.bat
        → G:/agent/runtime/node/node.exe --version == v22.21.1
        → 再跑一遍输出「已就绪」且 runtime 内文件 mtime 不变（幂等；setup 成功即退出不 pause，报错才 pause）
C 启动: cd G:/agent && ./启动U-Agent.bat & （后台起，等5秒）→ curl -s http://127.0.0.1:3080/ == 200（中文文件名 bat 从 Git Bash 直接执行已验证可用）
D 测试: G:/agent/runtime/node/node.exe --test G:/agent/test/ 全绿且 skipped=0
E 端到端: curl /api/chat（Mock provider）发「在工作区建 hello.txt 写入你好」
        → hello.txt 出现在工作区；data/sessions/*.jsonl 追加出 tool 事件
F 换机: xcopy /E /I /H G:\agent C:\tmp-uagent\ 后在副本里启动成功（C 路径 curl 200）
G git: git -C G:/agent status 干净；git ls-files | grep -E "^runtime/|^data/|^app/|config\.json$" 无输出；
        push 后 git ls-remote origin main == 本地 HEAD
H 反向验证: 临时把 data/settings.json 工作区指向白名单外(如 C:\Windows) → fs_write 被拒（贴拒绝输出）→ 还原后恢复
I 隔离: 启动前后 %USERPROFILE%\ 下无新增 .u-agent 等目录；%APPDATA%/%LOCALAPPDATA% 无新增相关目录
```

## v2 追加规格（2026-10-12 领导追加：常用功能补全 + 权限模式）

### 权限模式（五档，UI 右上下拉，随会话保存）

| mode | low | medium | high（fs_delete/fs_write覆盖/shell_run） | 说明 |
|---|---|---|---|---|
| confirm（默认） | 执行 | 执行 | 网页弹窗确认 | 逐次确认 |
| readonly 只读 | 执行 | 拒绝 | 拒绝 | 拒绝文案告知切模式 |
| plan 计划 | 执行 | 拒绝 | 拒绝 | 同只读 + 系统提示词追加「先调研并输出计划，不执行改动」 |
| auto 自动审批 | 执行 | 执行 | **拒绝**（危险命令不执行，领导原话） | 高危直接拦，返回提示 |
| full 完全权限 | 执行 | 执行 | 直接执行 | 全记 audit 日志 |

shell 黑名单（format/shutdown/reg delete/vssadmin/cipher /w/盘根递归删除）在**任何模式**都拒绝——工具内部实现，与模式无关。实现于 core/modes.mjs 的 `gate(mode, risk) → "run"|"confirm"|"deny"`。

### 新增工具

| 工具 | risk | 说明 |
|---|---|---|
| web_search(query) | low | 依次尝试：Tavily（settings 里配了 key）→ Brave（配了 key）→ DuckDuckGo HTML 抓取（免 key 尽力而为，失败返回明确错误提示去配 key）；返回前 8 条 标题+URL+摘要 |
| web_fetch(url) | low | GET 15s 超时，html/json/text 转纯文本（去 script/style/标签），截断 200KB |
| git_status/git_diff/git_log | low | cwd=工作区，输出截断 100KB；git 未装返回明确错误 |
| git_commit(message) | medium | git add -A + commit（仅限工作区内的 git 仓库） |
| git_push/git_pull | medium | 工作区仓库 push/pull origin 当前分支 |
| spawn_subagent(task, name?) | medium | 子 agent：独立上下文、继承当前模式、最多 15 步、禁再嵌套；独立 jsonl 日志（sessions/sub-*.jsonl）；返回最终文本 |

### 图片输入

- /api/chat 消息支持 text + images[]（base64 dataURL，单张 ≤5MB，单条 ≤4 张）；UI 支持粘贴(Ctrl+V)与文件选择，带缩略图预览
- 三协议映射：openai-chat→content[].{type:"image_url",image_url:{url:"data:..."}}；openai-responses→{type:"input_image",image_url:"data:..."}；anthropic→content[].{type:"image",source:{type:"base64",media_type,data}}
- 图片随会话 jsonl 落盘（data 字段保留，U 盘装得下）

### v2 追加验收

```
J 模式门禁: readonly 模式下 /api/chat 请求 fs_write → SSE 收到 deny 事件且文件未创建；
        auto 模式下 fs_delete → 拒绝事件；full 模式 → 直接执行；confirm 模式 → confirm_request 且 /api/confirm approve 后执行
K 图片: /api/chat 带 1 张 1x1 png base64（Mock provider）→ 会话 jsonl 里 user 事件含 images 且长度>0，对话正常完成
```

## v6 追加规格（2026-10-12 领导追加：模型预设库 + 选择器重做 + 密码锁加固）

### 模型预设库（对标 OpenCode 的 models.dev 目录思路）

OpenCode 的做法：75+ 厂商全在预设目录里，用户只做两件事——`/connect` 粘钥匙、`/models` 挑模型；协议/地址/模型清单由预设带。本期按同样思路落地（零依赖、不联网也成立，所以预设写在 `public/js/catalog.js`，不引远端目录）：

- `CATALOG`：22 家厂商，分四组（国内 / 国外 / 聚合中转 / 本机离线），每条含 `{协议, 服务地址, 候选模型, 拿钥匙的页面, 备注}`；覆盖 智谱 GLM、DeepSeek、Kimi、通义千问、MiniMax、火山方舟、腾讯混元、百度千帆、讯飞星火、OpenAI、Anthropic、Gemini、xAI、Mistral、Groq、Cohere、Azure、OpenRouter、硅基流动、Together、Fireworks、Ollama、LM Studio、vLLM、离线演示
- 三协议照旧：绝大多数厂商走 `openai-chat`，OpenAI 走 `openai-responses`，Anthropic 走 `anthropic`
- 模型名不必背：`POST /api/list-models` 现场用钥匙向厂商拉 `/models`（anthropic 走 `/v1/models`），拉回来点一下就选上；地址里还留 `{}` 占位符的直接拦下
- 只填钥匙即可：向导里协议/地址已预填，折叠在「高级」里，需要时才改

### 顶栏选择器重做（原生 select → 弹出面板）

- 模型：`厂商标记 + 通道名 · 模型 + 状态点`，点开是「搜索框 + 通道列表（厂商标记、模型、钥匙是否已填）+ 当前项打勾 + 管理通道入口」，占位里带「管理通道…」跳设置
- 权限：五档改成「图标 + 名称 + 两句说明」的卡片列表，当前项打勾；模式色进按钮（完全权限红、自动审批黄、只读/计划绿）
- 两个面板都支持 ↑↓ 移动、Enter 选定、Esc 关闭；搜索过滤后键盘选中项与过滤结果一致
- 斜杠命令 `/model`、`/mode` 改为直接改状态并广播事件，不再依赖 DOM select

### 添加通道向导

设置 → 模型 → 添加通道：**① 挑厂商**（带搜索、按组排布的品牌卡片，附「自己填服务地址」兜底）→ **② 填钥匙 + 选模型**（预填地址、模型快选标签、拉取模型列表、测试连接、高级折叠）→ 添加。刚配好且可用的通道自动切为在用。

### 密码锁加固（领导问「那不就谁都能用了吗」）

澄清并固化语义：**密码存在 U 盘 `data\lock.json`，跟盘走不跟机器走**——同一只盘插到任何电脑都是同一个密码；只有「这只盘从没设过密码」时才允许设置（`/api/lock-set` 在已设过的盘上返回 409 并提示走解锁/改密码）。

- 解锁页显示这只盘的密码设置时间与设置时的机器名，并写明「密码跟着盘走，换电脑还是这一个」；新盘则红字提示「第一个设密码的人就是盘的主人，别把没设过密码的盘外借」
- 暴力试防护：连错 5 次起进入冷却，`COOL_BASE(默认30s) × 2^(n-5)` 指数退避，上限 10 分钟；冷却期内 `/api/unlock` 一律 429 并回剩余秒数，前端按钮变倒计时
- 每次失败仍有 600ms 固定延迟；成功即清零计数

### v6 验收

```
V 预设库: catalog.js 覆盖 ≥20 家厂商，四组齐全；每家都有协议/地址/取钥匙页面
W 拉取模型: 未解锁 401；地址含占位符 → 400；连不上 → 400 带原因；mock → 200 给模型名
X 锁语义: /api/lock-status 返回 setup/setAt/setOn/cooldown；已设过密码的盘 lock-set → 409
Y 冷却: 连错 5 次后第 6 次 → 429 且带 cooldown；冷却结束用正确密码 → 200
Z 选择器: 静态资源全 200；页面无 JS 报错（无头浏览器实测）
```

## v7 追加规格（2026-10-12 领导选型：权限细粒度 + 上下文用量条 + @提及 + 改动总览 + 会话标题）

### 权限：五档模式 × 细粒度自动放行（对标 Cline Auto-Approve）

原来的五档只有"问/不问"的粗粒度，日常最烦的是"读文件也要点一下"。本期把 Cline 那套搬过来：**模式定大方向，开关定哪一类动作可以免问**。

- `core/modes.mjs` 新增 `TOOL_CATEGORY`（工具→类别）、`ACTION_OF`（类别→开关名）、`ACTION_META`（七项开关的中文名/说明/风险备注）、`DEFAULT_AUTO_APPROVE`
- 七项开关：读文件、改文件、删文件、跑安全命令、跑任何命令、联网、派子任务
- `isSafeCommand(cmd)`：在 shell 黑名单之外再做一层启发式——只读命令（dir/ls/type/cat/git status…）算安全；**含 `>` 重定向的一律不算**（会把内容写进文件）
- `gateWith(mode, risk, opts) → {g, auto, reason}`：套餐判定为 `confirm` 时才看开关；返回 `auto:true` 表示"这次是自动放行的"，事件里带标记，事后可追溯
- `maxRequests`：连续自动放行 N 次后回到"问我"（0 = 不限）；用户手动确认过一次即清零计数
- 优先级：完全权限/只读/计划这三档不受开关影响（本来就全放行或全拦）
- 前端：设置 → 权限 → 「自动放行」卡（总开关 + 七行单行开关 + 次数上限）；输入区上方状态条常驻显示"自动放行 X 等 N 项"，勾了高危项时变黄

### 上下文用量条 + 压缩

- 输入区上方一条状态条：左边权限模式（可点换）+ 自动放行摘要，右边上下文进度条（`S.budget.chars / BUDGET_CHARS(24k)`）+ 压缩按钮
- 70% 变黄、90% 变红并把文案换成"该压缩了"、压缩按钮高亮；空会话隐藏进度条并禁用压缩钮
- **预算必须是活的**：`/api/chat` 每轮跑完补发一次 `{type:"budget"}`（此前只在轮次开始前算，跑完不刷新，等于永远不会涨）；`GET /api/session` 也带上 `budget`，切回旧会话时用量条立刻正确
- 压缩成功后用返回的 `after` 直接刷新进度条

### v7 验收

```
a 细粒度: gateWith 覆盖 读/写/删/安全命令/任何命令/联网/子任务 七类；没勾的不放行
b 重定向: echo hi > a.txt 必须判为"非安全命令"
c 上限: 连续自动放行达 maxRequests 后回到 confirm，标记 auto:false
d 追溯: 自动放行的 tool_call 事件带 auto:true，与手动放行可区分
e 持久化: /api/settings POST 的 autoApprove 存得住、缺省键回落默认值；GET 能取回
f 生效: confirm 模式下勾了「改文件」→ 覆盖已有文件不再出现 confirm_request
g 活预算: 每轮结束都推 budget 事件且 chars 随轮次增长；/api/session 带 budget
h 拒绝提示: 动态风险工具被拦时，提示里是真实档位（high），不能把函数源码打进去
i @ 索引: 未解锁 401；子串匹配、node_modules 不进索引、文件名命中排前面
j 改动总览: change 事件带 rel/kind/±行数；覆盖写记成 edit 且带 diff 行；被拒的操作不留记录；落盘可回放
k 标题: 离线演示不起标题；配上轻量通道后首轮结束自动起标题并落盘；已有标题不覆盖
l 轻量通道: assist 存得住，压缩与起标题都走它
```

### @ 提及文件（v8 起：选中即带上内容）

输入框打 `@` 弹出工作区文件搜索，选中后插入 `@相对路径`，**并顺手把文件内容附在消息里**（v7 是只插路径，等 agent 自己去 `fs_read`；v8 改成直接带上，省一轮工具调用）。

- 后端 `GET /api/files?q=&limit=`：广度受限（扫描上限 2 万条、深度 12 层）走一遍工作区，只返回相对路径，不读内容；跳过 `node_modules`/`.git`/`dist`/`venv` 等目录；排序把"文件名命中"排在"路径深处命中"之前，避免深层同名文件挤掉用户想要的那个
- 后端 `GET /api/file-text?path=`：读工作区/U 盘目录内的文本文件（上限 64KB，超出截断并标注；含 0 字节按二进制拒读；越界路径 400）
- 识别规则：`@` 必须在行首或空白之后，且 `@` 到光标之间不能有空白——所以 `name@example.com` 不会误触发，打完 `@路径 ` 后面板自然关闭
- 前端在命令面板里加了第二种模式（`palKind`），文件模式不同于命令模式：插入的是路径而不是执行动作；索引按 `工作区 + 关键字` 缓存，换工作区自然失效
- 等待结果时先放一条"正在搜索工作区…"的占位项并标 `disabled`，避免这 100 多毫秒里按 Enter 把半截 `@` 直接发出去
- 系统提示词加一条：用户消息里的 `@相对路径` 表示他明确指向这个文件，动手前先 `fs_read` 读清楚
- 读不了 / 太大 / 二进制：静默回落到"只插路径"，不打断输入

### 本轮改动总览

每轮结束在消息流尾部出一张卡：改了哪几个文件、各是新增/修改/删除、`+增 −删` 行数，带 diff 的可展开看。

- `core/agent-loop.mjs` 新增 `CHANGE_KINDS`（fs_write/fs_edit/fs_delete/fs_move/fs_mkdir/git_commit）与 `buildChange()`，发 `{type:"change"}` 事件
- **关键点：preview 必须在工具跑之前算**——跑完再问 preview 拿到的已经是改动后的内容了。所以 agent-loop 把 preview 提前到门禁之后、执行之前，确认弹窗与改动总览共用同一次 preview（不重复读文件）
- fs_write 既能新建也能覆盖：按 preview 结论定稿 `kind`（`create` / `edit`），而不是一律记成写入
- 被拒 / 出错的工具**不产生** change 事件，否则这张卡会骗人
- 落盘：`change` 进 `LOG_TYPES`，回放旧会话时改动卡还在；子 agent 改的文件从 `subagent_event` 里拆出来，也记进主会话
- 存进日志的 diff 行上限 120 行，别把 jsonl 撑爆

### 会话标题自动生成 + 轻量通道

- 首轮回复结束后**后台**起标题：不阻塞这轮回复，写进 `data/titles.json`，前端在回复结束后再刷一次侧栏让它冒出来。每个会话只试一次，失败也不反复烧钱
- 标题清洗：去掉引号、「标题：」前缀、句号，截到 20 字以内
- 已有标题（人工改过或此前自动起的）一律不覆盖
- **轻量通道**：设置 → 模型 → 「轻量通道」，把起标题、压缩摘要这类杂活丢给便宜模型（比如本机 Ollama），省下主通道额度。留空则跟随当前在用通道
- 离线演示（mock）不参与这两件事——它只会鹦鹉学舌，起不出标题
- `pickAssist(st, fallback)` 统一决定杂活用哪条通道；`/api/compact` 也改走它

## v8 追加规格（2026-10-12 领导追加：继续对标成熟 agent —— 检查点/一键回滚 + 一批交互细节）

**调研**（GitHub 源码级，详见 PROGRESS）：Cline 的影子 git 检查点（每个工具调用后提交一次，还原三选项）、Claude Code `/rewind`（每轮一个检查点、保留 100 个、明确不追踪 shell 命令副作用）、Cursor（只还原文件）、Gemini `/restore`（还原后把原工具调用重新摆回待确认位）、JetBrains/VS Code Local History（文件级快照 + 配额保留）。**共性**：粒度都是"每个工具调用/每轮"、全都有配额、全都不追踪命令副作用、**Cline 与 Gemini 硬依赖本机 git** —— 便携场景（目标机可能没 git）用不了，所以自研文件级快照。

### 检查点 / 一键回滚（不依赖 git）

- 新增 `core/checkpoints.mjs`：改动类工具执行**之前**，把要动的路径原样复制进 `data/checkpoints/<会话>/<cpId>/`，并往 `<会话>/manifest.jsonl` 追加一条记录；回滚 = 按时间倒序把这些现场放回去
- 与业界方案的差别（也是本项目的取舍）：**只备份被碰过的文件**，不扫全仓库、不需要忽略规则清单 —— 从根上绕开 node_modules / 大二进制 / 软链接这些坑
- 快照上限：单文件 4MB、一个目录 400 个条目 / 16MB；拍不了的（超大、非普通文件）如实记 `skipped`，回滚时报"没撤成功 + 原因"，绝不假装成功
- **冲突检测**：工具跑完立刻记下改动后的内容指纹（`afterSha`）；回滚前比对，文件在改动之后又被改过 → 先拒一次（409 + `needForce` + 冲突清单），网页把按钮变成「仍要撤销」，再点一次才强制覆盖。一批一起撤时，同一文件只看最后一次记录的指纹（前面那些本来就是被后面盖掉的中间态）
- 回滚语义：新建的删掉、删除的恢复、移动的移回、目录连里面的文件一起还原（目录只删空的 —— 里面添了新东西就留着并如实报告）；一行 `change_revert` 进会话日志，回放旧会话时那张卡仍显示"已撤销"
- **撤销范围要说实话**：命令（shell_run）、git 提交造成的改动没有快照，卡片上如实标注（对标 Claude Code 的 "No code restore"）
- 容量：每个会话最多留 40 个检查点（更老的连备份一起清）、整盘 200MB（超了从最老的会话开始清，最多每 5 分钟收拾一次）；删会话连带删检查点；设置 → 安全 显示占用 + 一键清空
- 前端：`{type:"change"}` 事件带 `cp`（检查点 id），「本轮改动」卡右上角因此有「撤销本轮」——**两段确认**（第一下只是问，6 秒不点自动收回），撤销后卡片降透明度并写清结果
- 测试：`test/checkpoints.test.mjs` 13 例 + 服务端 6 例

### 只回退对话（对标 Claude Code /rewind 的另一半）

- 日志是追加式的，所以回退**不删**旧记录：写一条 `{type:"rewind", atIndex, dropped}` 标记，重建上下文（`buildHistory`/`rewindRanges`/`isDropped`）与界面回放（`renderHistory`）都跳过 `(atIndex, marker)` 区间里的事件，并在原位留一句系统提示「用户在此处回退过对话」——可审计、可追溯，多条回退各管各的区间
- `POST /api/rewind {sessionId, atIndex}`：只允许从「用户消息」处回退（非 user 位置 400）、这一轮还在跑就拒（409）、已经是最新一条就没什么可回退（400）；成功后返回新的上下文用量
- 界面：鼠标移到你说过的话上出现「从这儿重来」→ 两段确认 → 消息流出现虚线分隔「已回退到这里（丢弃 N 条记录）· 只影响对话，文件改动还在」，被回退的那句话放回输入框（附件块不跟着回来），改完直接再发
- 与文件撤销的分工：**文件撤销管文件、对话回退管上下文**，互不影响 —— 两者合起来就是业界检查点的完整三选项（仅文件 / 仅对话 / 两者）

### 确认弹窗可以附一句话（对标 Claude Code 的 permission prompt 评论）

- 批准就写清要求、拒绝就写明理由，这句话**原样转给模型**（拒绝时进 tool_result 文本，批准时附在工具结果之后），比一个干巴巴的"拒绝"有用得多
- `ConfirmGate.resolve(id, ok, note)`：裁决结果从布尔改成 `{ok, note}`，理由最长 500 字（别把上下文塞爆）；主循环对布尔与对象两种返回值都认，老调用方不用改
- 弹窗加「补一句话（可选）」输入框，每单清空，不许把上一单的话带过去

### 提醒（对标 Crush / OpenCode 的 attention 机制）

- `public/js/notify.js`：**只在页面被切走时打扰** —— 系统通知 + 标题闪烁，事件分开：需要批准 / 这一轮跑完 / 出错
- 通知权限只在用户手势里要（发送消息、点「试发一条」），拒绝了不影响任何功能；开关存浏览器本地（跟这台电脑走，不写 U 盘数据）
- 页面在前台时完全不打扰

### 输入框细节（对标 Claude Code / Codex / OpenCode 的小交互）

- ↑ 调出上一条输入（空输入框时），↓ 往回走；存最近 50 条，斜杠命令不入历史
- 粘贴时清掉不可见字符（零宽、方向控制符、word joiner 等），命中就明确提示"粘贴内容里有 N 个不可见字符，已清掉"—— 防提示词走私/伪装字符
- `/compact 保住接口细节`：压缩请求里带上用户点名的要求（`compactPrompt(msgs, keepTail, instruction)`）
- `/export`：把这次会话导出成 Markdown（用户/助手正文、工具调用、每轮改动、撤销记录、摘要）

### v8 验收

```
m 快照与撤销: 覆盖写 → change 事件带 cp → POST /api/rollback → 文件回到改动前；change_revert 进会话日志；清单里标 reverted
n 新建/删除: 撤销新建 = 文件消失；撤销删除 = 原样恢复
o 冲突: 改动之后又被改过 → 409 needForce + conflicts；force:true 才覆盖
p 锁与越界: 未解锁调 rollback/checkpoints 一律 401；/api/file-text 越界路径 400
q 提及带内容: /api/file-text 返回文本、超 64KB 截断、含 0 字节拒读、不存在 404
r 清理: 删会话连带删检查点；DELETE /api/checkpoints 清空整盘
s 附言: 拒绝时理由进 tool_result 与 confirm_result；批准时附在工具结果之后
t 压缩指示语: /api/compact 的 instruction 进压缩提示；不带时不出现那一行
u 界面实测（无头 Edge）：撤销两段确认、改动卡已撤销态、回放保持、检查点占用卡、@ 提及附内容、↑ 历史、粘贴清洗、/export，零 JS 报错
v 回退对话: 回退后新请求里不再出现被丢的那句、回退点之前的还在、带一句说明；非 user 位置 400；未解锁 401；日志追加不删旧记录；文件没被动过
```

### v8.2 追加：网关适配（OpenCode Zen / Go 这类"按模型分协议"的服务）

领导实测「填了 OpenCode Go 的钥匙，拉不到模型、也连不上」，查下来是三件事叠在一起，全部修掉：

- **地址不同**：Go 的接口是 `https://opencode.ai/zen/go/v1`，比 Zen 的 `https://opencode.ai/zen/v1` 多一层 `/go`；拿 Go 的钥匙打 Zen 地址会报 `Invalid credential`。→ 预设库补 `OpenCode Zen` / `OpenCode Go` 两家（聚合/中转组），地址、候选模型、说明都带好，向导里搜 "opencode" 就能选到
- **网关强制要会话标识**：Go 要求每个会话带稳定的 `x-opencode-session` 头（否则 400 `MissingSessionID`），并要求客户端自报家门。→ `core/providers.mjs` 的 `buildHeaders()`：主机是 opencode.ai（或通道来自这两家预设）时自动带上 `x-opencode-session=<本次会话 id>`，同一会话内稳定；所有请求带 `user-agent: u-agent/<版本>`。别家厂商一个多余的头发都不加
- **按模型分协议**：同一地址下 Claude 系走 `/messages`（Anthropic）、GPT/Grok 系走 `/responses`（Responses）、GLM/Kimi/DeepSeek/MiniMax 走 `/chat/completions`（OpenAI 兼容），Gemini 与 jev 走网关专用接口（本 agent 不支持）。→ `catalog.js` 的 `protocolForModel(modelId)`：向导里选中/输入模型即自动切协议并说明原因；已存在的通道若协议与模型不匹配，通道卡上出现「协议不对，点我改」一键修
- **地址纠偏**：用户常把文档里整条接口地址（`…/v1/chat/completions`）粘进「服务地址」。→ `normalizeBase()`（前端 `normalizeBaseURL` 同一套规则）去掉尾巴上的端点路径，失焦时纠偏并明确告知；对话、连通测试、拉取清单三条路都走它，**已经存坏的通道不用重填也能自愈**
- **`/v1` 不再叠两层**（真 bug）：anthropic 协议原来固定拼 `${base}/v1/messages`，地址本身带 `/v1` 时变成 `/v1/v1/messages`，网关直接掐连接。→ base 以 `/v1` 结尾时只拼 `/messages`
- **拉清单更皮实**：`/api/list-models` 按协议排出候选地址逐个试（`{base}/models`、`{base}/v1/models`），返回 HTML 时直说"多半把服务地址填成了官网/控制台地址"，全失败时把**每个地址各自的结果**列出来；接受 `{data:[]}`、`{models:[]}`、裸数组三种形状
- **报错说人话**：`friendlyUpstreamError()` 把 `MissingSessionID` / `Invalid credential` / 404 model 等翻成可操作的中文（并保留 HTTP 状态码与上游原文），其中钥匙类错误在 Zen 地址下会直接提示改用 Go 的地址
- **网络层失败也不许甩「fetch failed」**：`describeFetchError()` 按 `cause.code` 分辨 —— `ENOTFOUND` 说"域名解析不了（没网/DNS/需要代理）"、`ECONNREFUSED` 说"对方端口没在听（地址端口写错或本机服务没启动）"、`ECONNRESET` 说"连上又被掐断（需要代理/地址错/网关不认这个客户端）"、超时与证书问题各自单说；流跑到一半被切断另有说法（"回复中断…可以重发这一条"），别和"连不上"混为一谈。对话、连通测试、拉清单三条路都用它
- **测试必须离线**：不许在测试里打真实公网（换个网络环境就假失败）—— 网关行为用本地假网关复刻（照 Go 的规则：不带 `x-opencode-session` 就 400、钥匙不对就 401），纯字符串的指路逻辑放 `providers.test.mjs` 直测函数
- 验收：`test/providers.test.mjs`（地址纠偏、路径拼装、请求头、报错翻译）+ `test/catalog.test.mjs`（预设数、分协议映射、避重名）+ `test/server.test.mjs`（照 Go 规则搭的假网关：清单/连通/真跑一轮都通，且同一会话的会话标识稳定）+ 无头浏览器实测（搜得到两家、选 Claude 自动切 Anthropic、地址纠偏、不匹配徽标一键修），共 116 用例全绿、零 JS 报错

## v9 追加规格（2026-10-12 领导实测反馈：上下文太短 / 看不到思考过程 / 工具调用条与页面布局）

四个问题都是真的，先查业界现状再动手。**上下文太短**的根因是写死 `BUDGET_CHARS=24000` 字 + 一律按「2.5 字 = 1 token」估；去 models.dev（OpenCode 用的同一套目录，226 家 / 3971 个模型）拉了**当前**真实窗口：Claude 5 系、GLM-5.3、DeepSeek-v4、Kimi-k3、MiniMax-m3、qwen3.8 都是 **1000k 级**，GPT-5.6/6 系 1050k，Gemini-3 系 1049k —— 「128k/200k」那套印象早过时了。

- 新增 `core/model-windows.mjs`：**由 models.dev 数据生成**的家族表（62 条：窗口 / 输出上限 / 是否自带思考）+ 最长前缀匹配（`gpt-5.4` 不被 `gpt-5` 抢先）+ 厂商前缀剥离（`openai/gpt-5.2`）与点号短横两种写法（`claude-sonnet-4.5` = `claude-sonnet-4-5`）
- 覆盖顺序：通道里手填「上下文窗口」 > `data/model-windows.json`（可选，方便日后同步） > 家族表 > 兜底（云端 200k；**本机小模型 32k、家族值封顶 64k**——本地显存与默认配置远小于云端，按云端数字算会一塞就爆）
- `core/context.mjs`：token 估算改成**中日韩字符 1 字 1 token、其余 3.6 字符 1 token**，每条消息加固定开销，图片 900 token/张；`budgetOf(msgs, {limitTokens, windowTokens})` 返回 `{tokens, limitTokens, windowTokens, pct, warn, over}`（80% 提醒 / 100% 越界）
- 预算 = 窗口 × 75%（留 25% 给输出、工具结果与思考）；anthropic 的 `max_tokens` 也按模型真实输出上限（封顶 64k），不再写死 8192
- 全链路带上窗口信息：`/api/chat` 的 `session`/`budget` 事件、`GET /api/session`、`/api/rollback`、`/api/compact`；新增 `POST /api/model-info` 给设置页显示「窗口多大、预算多少、支不支持思考、数据从哪来」；用量条改成 token 占比（`150 / 25k · 1%`），通道卡新增「上下文窗口」输入（留空=自动）

**模型思考过程**：三协议都解析成独立的 `reasoning` 通道（不混进正文、不回传给模型）——`openai-chat` 认 `reasoning_content`/`reasoning`/`thinking`；`openai-responses` 认 `reasoning_summary_text.delta` 且请求带 `reasoning:{summary:"auto"}`（网关不认就 400 重试去掉）；`anthropic` 认 `thinking_delta`/`signature_delta`，并**默认显式开思考**（budget 取输出上限 1/4、封顶 16k，`thinking:false` 可关）。**多轮合规**：anthropic 开了思考后下一轮必须把 thinking 块连签名原样放回 assistant 消息（`end` → `assistant_message` 事件 → `buildHistory` → `bodyAnthropic` 最前面），否则 API 会拒。界面：`✻ 思考中… N 秒` 流式展开，正文一来收成 `✻ 已思考 N 秒`（可点开），插在回复气泡上方；`/thinking` 与设置 通用→对话显示 可整体显隐（同 OpenCode 的 `/thinking`）；Mock 剧本支持 `think:"…"` 便于离线演示。

**工具调用条**：从带边框大卡片改成 codex 风格**单行条**（`• 工具名 参数摘要 结果首行 状态·耗时`），连续调用归进同一个带左竖线的组（对标 Claude Code 把 MCP 调用收成 `Called slack 3 times` 一行），点开才看参数与完整结果；运行中显示跳动圆点，失败/被拒自动展开；`/details` 一键展开或收起。

**页面布局**：内容列 780 → **940px**（输入区、状态条同宽），底部留 140px 不让最后一条被输入框压住，消息间距收紧；顶栏新增**运行中胶囊**（`● 运行中 12 秒` + 停止按钮）；顺手修了「发第一条消息后欢迎页赖着不走」（选择器 `#welcome` 应为 `.welcome`）。

### v9 验收

```
w 窗口表: 认得出的模型给真实窗口（Claude/GPT/GLM/DeepSeek 几十万到百万级）；gpt-5.4 不被 gpt-5 抢先；厂商前缀与两种写法都能命中；认不出 200k、本机 ≤64k、手填优先
x token 估算: 中日韩 1 字 1 token；预算按传入额度算，80% warn / 100% over
y 思考流: 三协议各自字段都解析成 reasoning；anthropic 请求带 thinking 且 max_tokens > budget、关掉后不带、下一轮 thinking（含签名）原样回传
z 工具条与布局: 单行渲染 + 左竖线分组 + 展开看细节；内容列 940px；运行中胶囊在等待批准时可见、结束后隐藏
```

## v4 追加规格（2026-10-12 领导圈定 P0+P1，对标 codex）

### P0
1. **多轮上下文 + /compact**：/api/chat 从会话 jsonl 重建历史发给模型（当前是每条独立，重大 bug）；看板/预算：估算 token（字符/2.5），超 24k 字提示压缩；POST /api/compact 用模型把旧轮次摘要成 {type:"compact",summary,keep} 事件，历史重建时用摘要替代被压部分。core/context.mjs 纯函数实现 + 单测
2. **AGENTS.md 注入 + /init**：工作区根 AGENTS.md（≤8KB）自动进系统提示；/init 前端展开为提示词让 agent 生成该文件
3. **写操作 diff 预览**：工具可导出 preview(args,ctx)；fs_write 覆盖→行级 diff（core/diff.mjs LCS，超 400 行截断），fs_edit→老/新对照，fs_delete→目标信息；confirm_request 事件带 preview，网页弹窗渲染 +/- 着色
4. **update_plan 计划工具**：risk low，参数 {items:[{step,status:pending|doing|done}]}；事件 {type:"plan"} 泵入主流；网页渲染计划卡（含进度），同会话新计划覆盖旧卡；当前计划注入系统提示
5. **Ollama 离线预置**：config.example.json 加「Ollama 本地」行（openai-chat, http://127.0.0.1:11434/v1）；provider 无 secret 时不发 Authorization 头；README 离线用法
6. **用量显示**：适配器解析 usage（chat: stream_options.include_usage 末块；anthropic: message_start/message_delta；responses: response.completed.usage）发 {type:"usage"}；网页顶栏显示「上下文≈x 字 · 本会话 y tokens」；/status 弹详情

### P1
7. **持久记忆**：U 盘 data/memory.md，GET/POST /api/memory；≤4KB 注入系统提示；/remember 追加；设置抽屉可编辑
8. **斜杠命令面板**：输入框打 / 弹面板（↑↓ 选、Enter 定），支持 /new /mode /model /compact /init /status /remember /help；filter 即输即筛
9. **会话重命名**：POST /api/session-rename {id,title} 存 data/titles.json；侧栏双击改名
10. **文本文件拖入**：拖拽/粘贴文本文件（≤100KB/个，合计 200KB）转成代码块并入消息

### v4 验收
```
O 多轮上下文: 本地假上游捕获第二次请求 body → messages 含第一轮 user+assistant
P 压缩: /api/compact 后会话有 compact 事件；再次 chat 请求 body 中旧轮次被摘要替代
Q diff 预览: confirm 模式覆盖写 → confirm_request.preview.kind=="diff" 且含 +/- 行
R 计划: MOCKSCRIPT 调 update_plan → 事件流有 plan；系统提示含当前计划
S 记忆: POST /api/memory 后 systemPrompt 含该内容（单测）；前端 /remember 追加
T 重命名: rename 后 ls 列表 title 变化
```

## 已知限制（写进 README）
```

## v3 追加规格（2026-10-12 领导追加：密码锁 + 钥匙不可见 + 去除敏感字样）

### 密码锁（每次使用必输）

- 首次打开网页：要求设置密码（输两遍，≥4 位），存 `data\lock.json`（scrypt 加盐哈希，绝不存明文）
- 之后每次启动服务（每次双击 bat / 每次新开会话网页）都需要输密码解锁；解锁前所有功能接口一律 401
- 会话令牌：解锁后发 HttpOnly Cookie（内存态，服务重启即失效）；「设置」里可改密码（需输旧密码）
- 忘记密码：删掉 U 盘 `data\lock.json` 重设（README 说明）
- 接口白名单（免解锁）：/api/health、/api/lock-status、/api/unlock、/api/lock-set、/api/lock-change；其余 /api/* 必须携带有效会话
- 验证失败固定延迟 600ms（防暴力试）

### 钥匙保管（用户可见层"不可直接查看"）

- 网页设置里钥匙框一律不回显（已保存显示为空 + 占位提示「已保存——不改请留空」），只有输入新值才更新
- 落盘从明文 JSON 改为 `data\vault.bin`（AES-256-GCM 加密的数据文件，防记事本直接偷看；属混淆级防护，README 如实说明）
- 改密码不影响 vault（vault 密钥与应用绑定，与登录密码解耦）

### 命名规范（用户可见层禁用 api 相关字样）

- UI 与提示语：「API key」→「钥匙」；「Provider」→「模型通道」；「baseURL」→「服务地址」
- 涉及文件：data\credentials.json（明文）废弃 → data\vault.bin；data\lock.json（密码锁）
- 代码内部字段统一用 secret（此前 apiKey 字样一并清除），用户可见文案用「钥匙」

### v3 追加验收

```
L 密码锁: 未解锁访问 /api/settings → 401；lock-set 设密码 → 解锁错密码被拒（600ms 延迟）→ 对密码解锁拿到 Cookie → 功能接口 200；服务重启后旧 Cookie 失效
M 钥匙不可见: 保存含钥匙的通道后，/api/settings 回显不含钥匙原文；data/vault.bin 内容（AES-GCM）不含钥匙明文；config.json 同样不含
N 字样扫描: public/index.html 与 README.md 中不出现「API key」「apikey」等用户可见字样（代码内部字段除外）

- 目标机需能访问所选模型服务（联网）；离线可用 Mock 体验界面
- API key 明文存 U 盘（data/credentials.json），U 盘别外借；加密不在本期范围
- shell 超时 30s、输出 200KB 上限；长任务拆步骤
