# 第三方组件与参考来源

本仓库代码为自研零依赖实现（无 npm 依赖），但若干设计与部分文件建立在下列开源项目之上。
按「借到什么程度」分两类：**借了内容/文件的，按各自协议在此保留声明**；**只参考了设计的，列出出处致谢**。

> 如果你（或后续贡献者）从下面任何一个仓库直接复制了文件，请在**该文件头部**留一行来源注释，并在本文件「一」里补上对应条目。

---

## 一、借用了内容或文件的（保留原声明）

### deepseek-ai/deepseek-harness（dsh） · MIT

用到了什么：内核设计——Agent = Model + Harness、高风险工具审批、会话追加日志、并行工具声明制等。

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

来源：https://github.com/deepseek-ai/deepseek-harness

### yuluyangguang1/hermes-portable · MIT

用到了什么：U 盘便携打包——启动脚本与「便携 node + 相对路径」的目录组织方式。

```
MIT License

Copyright (c) 2026 yuluyangguang1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

来源：https://github.com/yuluyangguang1/hermes-portable

### bnovik0v/portable-agent-usb · MIT

用到了什么：便携打包思路与目录结构。

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

来源：https://github.com/bnovik0v/portable-agent-usb

### sst/models.dev · MIT

用到了什么：模型上下文窗口 / 输出上限数据（`core/model-windows.mjs` 的表来源）。

```
MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

来源：https://github.com/sst/models.dev

### simple-icons · CC0-1.0（无需署名，仍在此致谢）

用到了什么：厂商图标的 SVG 路径（`public/index.html` 里的 `i-v-*` 符号），用于通道卡与模型弹层的品牌识别。

- 图标集本身以 CC0-1.0 释出（https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md），不要求署名；
- **图标与品牌名是各自公司的商标**，本项目只在「这是哪家厂商的通道」这一识别意义上使用，不代表任何厂商背书。

### Node.js · MIT（随发行包自带）

用到了什么：U 盘里的便携运行时 `runtime/node/`（由 `setup-uagent.bat` 从 npmmirror 下载，不进 git）。
Node.js 的发行包里已自带其 LICENSE 文件——**整盘分发时保留该文件即可**，无需在此重复声明。

---

## 二、只参考了设计 / 做法的（列出出处致谢，无版权义务）

代码是对照设计自行重写的，没有搬运。仅在此致谢：

| 项目 | 协议 | 参考了什么 |
|---|---|---|
| [zai-org/ZCode](https://github.com/zai-org/ZCode) | Apache-2.0 | 对话渲染设计语言（单行工具卡 + 动词标签 + 文件名徽章 + 悬停箭头、思考行「思考 · 持续了 N 秒」、只读分组头）、空态首页层次（居中问候 + 内联输入框 + 推荐任务 + 背后水印）、设置与命令台的信息架构 |
| [liliMozi/openhanako](https://github.com/liliMozi/openhanako) | Apache-2.0 | 人格与记忆的做法（人格 = 可编辑文件 + 语言模板回落 + 预设；记忆 = 有上限的编译产物 + 整理）、「写人格的手艺」（行为规则 > 形容词、语言指纹、台词范例、去模板感） |
| [openai/codex](https://github.com/openai/codex) | Apache-2.0 | 审批作用域、超长输出落盘可恢复、`/goal` 完成标准、`/init` |
| [sst/opencode](https://github.com/sst/opencode) | MIT | 厂商预设的组织方式（厂商 → 协议 + 地址 + 候选模型）、命令面板 |
| [MiniMax-AI/MiniMax-Code](https://github.com/MiniMax-AI/MiniMax-Code) | MIT | Enter 排队接着说、回退对话等交互 |
| [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) | Apache-2.0 | 中断提醒、上下文压缩的取舍 |
| Claude Code / Codex 的公开文档与产品交互 | — | 细节参考（`/compact`、`/thinking`、Esc 语义、回退与分叉） |

> 若将来要从这些仓库**直接复制代码**：Apache-2.0 的项目（ZCode / openhanako / codex / kimi-cli）需要保留其 NOTICE、标注修改过的文件；
> MIT 的项目（opencode / MiniMax-Code）需要保留版权行与许可文本。届时请把这些条目挪进「一」并附上许可原文。
