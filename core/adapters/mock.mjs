// 离线演示：MOCKSCRIPT 剧本 + 离线向导一问一答
// （2026-10-15 从 core/providers.mjs 拆出；一个功能一个文件）
const GUIDE_QA = [
  {
    k: [
      "介绍", "介绍一下", "这是什么", "是什么", "干什么的", "干什么用", "有啥用", "有什么用", "用途",
      "功能", "能做什么", "能干什么", "可以做什么", "会什么", "怎么用", "如何使用", "使用方法", "用法",
      "教程", "帮助", "help", "说明书", "上手指南", "入门", "新手", "这个应用", "这个软件", "这个工具",
      "这套东西", "这个盘", "u-agent", "uagent", "你是谁", "自我介绍",
      "干嘛", "干啥", "做啥", "干什么", "软件", "程序", "app",
    ],
    a: "u-agent 是插在这台电脑上的便携 AI：配置、钥匙、聊天记录全放在这只 U 盘里，双击盘上的「启动U-Agent.bat」就能用，换台电脑不用重配。\n它会读写工作区里的文件、跑命令、查 git、联网查资料；动文件、跑命令前会先问你（权限模式可调）。\n我现在是离线向导，只答用法：换工作区 / 换模型填钥匙 / 权限怎么选 / 回退撤销 / 导出备份 / 联网搜索 / 快捷键……挑一个问就行。",
  },
  {
    k: ["怎么开始", "从哪开始", "第一步", "怎么上手", "第一次用", "不会用", "看不懂", "新盘", "初始"],
    a: "三步就能开跑：\n① 「设置 → 模型」挑一家厂商、粘上钥匙（想先试试手感就留在 Mock 问我）；\n② 点输入框上面的「工作区」胶囊挑一个文件夹——它就只在这个目录里动手；\n③ 在输入框里说人话，比如「把工作区的文件列一遍」。",
  },
  {
    k: ["怎么让它干活", "怎么说话", "怎么指挥", "怎么提问", "怎么发消息", "能不能干活", "能干活吗", "干真活"],
    a: "直接在输入框说人话就行，不用背语法。几个小技巧：\n· 输入 @ 能从工作区里挑文件带进对话\n· 输入 / 会列出所有命令\n· 图和文件可以直接贴/拖进输入框\n· 一次把目标说清楚，它会自己拆步骤、调工具来做。",
  },
  {
    k: ["读文件", "改文件", "写文件", "能不能读", "能改吗", "会改", "动文件", "删文件", "权限是"],
    a: "能：读写工作区里的文件、跑命令行、查 git、上网搜。\n默认「谨慎」档：动文件、跑命令之前会弹窗让你确认，你点同意它才动；输入框左下角那颗胶囊可以换成「自动 / 只读 / 完全权限」。",
  },
  {
    k: ["图片", "照片", "截图", "附件", "拖进来", "贴图", "发图"],
    a: "能带图：输入框右边「附件」可以选图片或文本文件，图也可以直接拖进输入框。\n带图问它「这张图讲了什么」「照这个截图改一下」都行。",
  },
  {
    k: ["session", "会话在哪", "历史记录", "聊天记录", "怎么新建", "新会话", "清空对话", "换个话题"],
    a: "左边侧栏就是会话列表（今天 / 更早分组），点一条就切过去。\n开新会话：侧栏或顶部的「+ 新会话」（也可以输入 /new）。记录都躺在 U 盘的 data/sessions 里。",
  },
  {
    k: ["花了多少钱", "费用", "计费", "token", "用量", "多少钱", "消耗"],
    a: "状态条右边那条「上下文」是本轮 token 进度；每轮末尾还会标「首字 / 生成 / 缓存命中」。\n花多少钱取决于你接的那家厂商，u-agent 本身不收费。",
  },
  {
    k: ["数据安全", "隐私", "上传", "会不会泄露", "传出去", "会不会偷", "安全吗", "数据在哪"],
    a: "对话、配置、钥匙全在这只 U 盘里：钥匙加密存在 data/vault.bin，页面上只回显掩码。\n唯一往外发的是你接的模型通道（和联网搜索），u-agent 自己不往任何服务器传数据。",
  },
  {
    k: ["报错", "卡住", "不动了", "没反应", "失败了", "出错", "怎么办"],
    a: "先按 Esc 停这一轮，再看红字提示。常见的两种：\n① 钥匙或额度的问题 → 「设置 → 模型」里点「测试连接」看看；\n② 本地服务被关了 → 重新双击盘上的「启动U-Agent.bat」。",
  },
  {
    k: ["goal", "/goal", "一直做", "别半途", "完成标准", "做到好为止"],
    a: "给它一个完成标准它就不会半途收工：输入 /goal 里面有测试全绿 —— 没达成它会一直做下去。/goal clear 取消。",
  },
  {
    k: ["测试", "跑检查", "lint", "代码质量", "跑一遍", "检查命令", "质检"],
    a: "「设置 → 通用 → 检查命令」里把 test / lint 命令填上，之后说「跑一遍检查」它就跑；它改完代码也会自动跑（可以在那里关掉）。",
  },
  {
    k: ["手机", "远程", "局域网", "别的电脑", "手机上", "多设备"],
    a: "手机连不上——服务只监听本机 127.0.0.1，这是为了安全（盘里的钥匙不外流）。\n想换电脑用：把整个文件夹拷过去，双击 bat 就行。",
  },
  {
    k: ["卸载", "换电脑", "搬走", "删除软件", "怎么装", "安装", "免安装"],
    a: "它不是安装出来的软件：把 U 盘上的整个文件夹删掉就等于卸载干净。\n换电脑：整个文件夹拷到新盘/新电脑，双击「启动U-Agent.bat」，钥匙和记录都跟着走。",
  },
  {
    k: ["工作区", "工作目录", "换目录", "换文件夹", "文件夹", "哪个目录", "换个地方", "目录在哪", "工作空间"],
    a: "点输入框上方那颗「工作区」胶囊（写着当前目录的那颗）：里面能直接换——最近用过的目录点一下就行，挑新目录走「打开文件夹…」，选完立刻生效，不用进设置。\n它只在这个目录（和 U 盘）里读写文件。",
  },
  {
    k: ["换模型", "换通道", "模型在哪", "添加通道", "接入模型", "配模型", "换个模型", "模型怎么"],
    a: "换：点输入框左下角写着模型名的那颗胶囊（只列已经配好的）。\n加：去「设置 → 模型 → 添加通道」，内置 20+ 家厂商，协议和服务地址都预置好了，你只要粘一把钥匙、挑一个模型。",
  },
  {
    k: ["钥匙", "apikey", "api key", "密钥", "填key", "怎么填", "没有钥匙"],
    a: "「设置 → 模型」里展开通道卡片，把厂商给你的钥匙粘进「钥匙」框，保存即可。\n钥匙存在这只 U 盘的 data/vault.bin（加密的），页面上永远只回显掩码，看不到原文。",
  },
  {
    k: ["权限", "每次问我", "老是问", "总问", "老是弹", "弹窗", "自动放行", "模式", "不用确认", "别问我", "别问", "太烦", "烦", "打扰"],
    a: "输入框左下角那颗胶囊就是权限档：\n· 谨慎 = 动文件、跑命令都先弹窗问你\n· 自动 = 常规操作直接做，危险的才问\n· 只读 = 只看不改\n· 完全权限 = 不设任何边界（慎用）\n「设置 → 权限」里还能按动作单独放行。",
  },
  {
    k: ["回退", "撤销", "改错", "还原", "撤回", "反悔", "改坏了", "恢复原样"],
    a: "鼠标移到你说过的那句话上：\n· 「从这儿重来」= 回退对话（按住 Alt 点它 = 连这段的文件改动一起回滚）\n· 文件改动本身：在对话里的改动卡上点「撤销本轮改动」。",
  },
  {
    k: ["分叉", "分支", "另开一条", "两条路"],
    a: "在你说过的话上点「分叉」= 从这一句拉出一条新会话，原会话一个字都不动——适合拿它试另一种做法。",
  },
  {
    k: ["导出", "备份", "带走", "保存记录", "存下来", "记录在哪"],
    a: "输入 /export 把这次会话导出成 Markdown 文件。\n整只盘的数据都在 U 盘的 data/ 里，整个文件夹拷走就是备份（锁和钥匙也在里面）。",
  },
  {
    k: ["联网", "搜索", "搜不了", "上网", "代理", "外网", "没网", "搜不出来", "能不能搜"],
    a: "联网搜索默认不用钥匙（内置 5 个引擎兜底）；要更稳就在「设置 → 联网」填 Tavily 或 Brave 的钥匙。\n公司网络出不去的话，这一页也能填 HTTP 代理。",
  },
  {
    k: ["记忆", "记住", "长期", "记不住", "忘性"],
    a: "输入 /remember 后面接一句话，就写进跨会话记忆（data/memory.md）——以后每一轮它都带着，换会话也不忘。",
  },
  {
    k: ["技能", "skill", "本事", "专门做法", "套路"],
    a: "把一套做法写成 .agent/skills/名字/SKILL.md，放在工作区或 U 盘里都行；用的时候输入 /skill 加载它。",
  },
  {
    k: ["快捷键", "热键", "键盘"],
    a: "Ctrl+K 命令台 · Ctrl+F 会话内查找 · Ctrl+/ 快捷键表 · Shift+Tab 切权限档 · Esc 停止这一轮。",
  },
  {
    k: ["密码", "忘记密码", "解锁", "上锁", "改密码", "密码是啥"],
    a: "密码跟着盘走（data/lock.json），插到别的电脑还是这一个。\n忘了就删掉 data/lock.json 重新设一个——通道钥匙不受影响。",
  },
  {
    k: ["上下文", "压缩", "吃满", "太长", "装不下", "compact"],
    a: "状态条上「上下文」那条进度就是这轮还能吃多少；到 80% 会自动压缩，也可以点旁边的「压缩」手动瘦身（还能点名保住什么，比如 /compact 保留接口细节）。",
  },
  {
    k: ["子代理", "并行", "分身", "多个任务"],
    a: "直接说「派两个子代理分头查」——它会拆出子任务并行跑，最后汇总回来。",
  },
  {
    k: ["计划模式", "先出计划", "别急着做", "先看看"],
    a: "输入框左下角有「计划」开关：开了它先只读调研、出一份计划给你批准，你点头才动手。",
  },
  {
    k: ["后台", "长命令", "任务胶囊", "跑很久"],
    a: "跑得久的命令会自动挂到后台，状态条上冒出一颗任务胶囊——点开能看输出、能停。",
  },
  {
    k: ["什么模型", "离线", "收费", "花钱", "不用联网", "mock", "你是真的吗", "真的假的", "真的模型", "是不是模型", "真人", "是人吗", "你是ai吗", "你是ai"],
    a: "我现在是 Mock（离线向导）：不联网、不花钱，只能答疑和演示工具链路。\n接真模型走「设置 → 模型 → 添加通道」（那儿也有一个「离线向导」条目，删了我还能加回来）。",
  },
  { k: ["谢谢", "多谢", "感谢", "辛苦了"], a: "不客气。还有想问的尽管问——或者去「设置 → 模型」接一家真通道，让我真干活。" },
];
const GUIDE_MENU =
  "这句我按关键词没认出来（我是离线向导，靠词表答，不是真模型）。换种问法试试，比如：\n「介绍这个应用」「怎么开始」「怎么换工作区」「怎么换模型 / 怎么填钥匙」「权限怎么选」「怎么回退、撤销改动」「怎么导出备份」「怎么联网搜索」「快捷键有哪些」……\n想干真活的话，去「设置 → 模型 → 添加通道」接一家真厂商（填把钥匙就行）。";

// 去掉空格和常见标点再比：领导会打「怎么换 工作区？」这种带空格/标点的句子
const guideNorm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[？?！!。.，,、；;：:（）()【】\[\]"'“”‘’~～\-—…/\\]/g, "");

// 泛问法（介绍/怎么用/有什么用…）权重减半：免得「搜索怎么用」被总介绍那条抢走答案
const GUIDE_WEAK = new Set(
  [
    "介绍", "介绍一下", "这是什么", "是什么", "干什么的", "干什么用", "有啥用", "有什么用", "用途", "功能",
    "能做什么", "能干什么", "可以做什么", "会什么", "怎么用", "如何使用", "使用方法", "用法", "教程", "帮助",
    "help", "说明书", "上手指南", "入门", "新手", "这个应用", "这个软件", "这个工具", "这套东西", "这个盘",
    "怎么办", "吗",
    // 泛问词：不带主题信息，权重压低，别把「代理怎么填」这类抢到别处去
    "怎么填", "干嘛", "干什么", "干啥", "做啥", "软件", "程序", "app",
  ].map((s) => s.toLowerCase())
);

function guideAnswer(text) {
  const t = guideNorm(text);
  let best = null;
  let bestScore = 0;
  for (const item of GUIDE_QA) {
    // 命中的关键词越长越具体（「忘记密码」压过「密码」），同分时先声明的先赢
    const score = item.k.reduce((n, k) => {
      const kk = guideNorm(k);
      if (!kk || !t.includes(kk)) return n;
      return n + (GUIDE_WEAK.has(kk) ? Math.max(1, Math.floor(kk.length / 2)) : kk.length);
    }, 0);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best ? best.a : null;
}

function mockScript(userText) {
  // v0.9.8 起用户消息会带「当前时间」等前缀行（只发给模型、不进日志）——先跳过这些元信息行再认剧本
  const first = String(userText || "")
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("【当前时间") && !l.startsWith("（注意：上一轮"));
  const t = (first || "").trim();
  if (t.startsWith("MOCKSCRIPT:")) {
    return JSON.parse(t.slice("MOCKSCRIPT:".length));
  }
  if (/建文件|创建|hello/.test(t)) {
    return [
      { tool: "fs_write", args: { path: "hello.txt", content: "你好，来自 u-agent" }, say: "我来在工作区创建 hello.txt。" },
      { say: "已创建 hello.txt，内容是「你好，来自 u-agent」。\n（这是离线演示：接上真模型之后，你让它干什么它才真干什么。）" },
    ];
  }
  // 日常提问 → 离线向导一问一答；认不出来的给一张「你能问我什么」的菜单
  return [{ say: guideAnswer(t) || GUIDE_MENU }];
}

async function* streamMock(provider, messages, tools, signal) {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = messages[lastUserIdx];
  const script = mockScript(lastUser?.text || "");
  // 剧本进度按「这轮已经回了几步」算：一步 = 一条带工具调用的 assistant 消息。
  // 不能只数 tool 消息——一步里可能并行调多个工具，会把后面几步一起跳掉；
  // 但手工拼出来的历史（测试里那种只有 tool 消息的）也要兼容：没有 assistant 就退回数 tool。
  const afterUser = messages.slice(lastUserIdx + 1);
  const asstSteps = afterUser.filter((m) => m.role === "assistant").length;
  const toolCount = asstSteps > 0 ? asstSteps : afterUser.filter((m) => m.role === "tool").length;
  const rest = script.slice(toolCount);
  // 剧本里写 think:"…" 就先吐一段思考过程，方便离线演示与测试
  if (rest.length && rest[0].think) {
    for (const ch of String(rest[0].think)) {
      yield { type: "reasoning", delta: ch };
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  // 一轮里并行调多个工具：{ tools: [{tool, args}, …], say? }（模拟真实模型一次给多个 tool_calls）
  if (rest.length && Array.isArray(rest[0].tools) && rest[0].tools.length) {
    const step = rest[0];
    if (step.say) yield { type: "text", delta: step.say };
    const tcs = [];
    for (const one of step.tools) {
      const id = `mock_${tcs.length}_${Math.random().toString(36).slice(2, 6)}`;
      yield { type: "tool_start", id, name: one.tool };
      yield { type: "tool_delta", id, delta: JSON.stringify(one.args || {}) };
      tcs.push({ id, name: one.tool, args: one.args || {} });
    }
    yield { type: "end", stopReason: "tool_calls", toolCalls: tcs };
    return;
  }
  if (rest.length && rest[0].tool) {
    const step = rest[0];
    const id = `mock_${Math.random().toString(36).slice(2, 8)}`;
    if (step.say) yield { type: "text", delta: step.say };
    yield { type: "tool_start", id, name: step.tool };
    yield { type: "tool_delta", id, delta: JSON.stringify(step.args || {}) };
    yield { type: "end", stopReason: "tool_calls", toolCalls: [{ id, name: step.tool, args: step.args || {} }] };
    return;
  }
  const text = rest.map((s) => s.say || "").join("");
  for (const ch of text) {
    yield { type: "text", delta: ch };
    await new Promise((r) => setTimeout(r, 4));
  }
  yield { type: "end", stopReason: "stop", toolCalls: [] };
}

// ---------- 统一入口（带重试壳） ----------


export { GUIDE_MENU, GUIDE_QA, GUIDE_WEAK, guideAnswer, guideNorm, mockScript, streamMock };
