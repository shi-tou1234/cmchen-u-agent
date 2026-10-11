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
├── core\confirm.mjs          ← 高危操作 pending 表：创建→等网页确认→放行/取消（带超时60s）
├── core\sessions.mjs         ← 会话 JSONL 追加日志（data/sessions/<id>.jsonl）
├── tools\                    ← 每个工具一个 .mjs，export {name,description,params,risk,run}
├── public\index.html         ← 原生 JS 单文件聊天页
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

## 网页（public/index.html）

会话侧栏 + 聊天流（流式打字机）+ 工具卡（名称/参数/结果，可折叠）+ 高危确认弹窗 + 设置抽屉（providers 增删改、key、工作区选择）+ 停止按钮（abort 主循环）。SSE 收 `/api/chat`，POST `/api/confirm`，GET/POST `/api/settings`，GET `/api/sessions`。全部原生 JS，不引任何外部 CDN（目标机可能无外网到 CDN）。

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
