// 破坏系统命令黑名单：任何权限模式都拦。覆盖所有「把整条命令交给 cmd.exe 执行」的路径
// （shell_run / shell_bg / 后台任务 / 自动检查 checks）；hooks 与 MCP 是 argv 直启（不经 cmd），
// 不在本闸射程——那两处靠「用户自己写的 + 信任闸/默认逐次确认」兜底。
// 参数顺序无关化：审查 #8 实测 `del g:\x /f /s /q`（/s 在路径后）与 `Remove-Item C:\temp\x -Recurse`
// 原先都漏网；PowerShell 的磁盘 cmdlet 全家也补进来。core/blacklist.mjs
const BLACKLIST = [
  [/format\s+[a-z]:/i, "格式化磁盘"],
  [/\bshutdown\b/i, "关机/重启"],
  [/\breg(\.exe)?\s+delete\b/i, "删注册表"],
  [/\bvssadmin\b/i, "删卷影副本"],
  [/\bcipher\s+\/w\b/i, "擦写磁盘空闲空间"],
  [/\b(rd|rmdir)\b(?=[^&|>]*\/s)/i, "递归删目录（rd /s）"],
  [/\bdel\b(?=[^&|>]*\/s\b)(?=[^&|>]*[a-z]:\\)/i, "递归删绝对路径（del /s + 盘符）"],
  [/\bdiskpart\b/i, "磁盘分区操作"],
  [/\bbcdedit\b/i, "改启动配置"],
  [/\bremove-item\b(?=[^&|>]*-recurse)(?=[^&|>]*[a-z]:\\)/i, "PowerShell 递归删绝对路径"],
  [/\b(format-volume|clear-disk|remove-partition|initialize-disk|new-partition|add-partition)\b/i, "PowerShell 磁盘/分区操作"],
  // 下载执行 / 持久化族（SEC-008）：黑名单是防手滑的护栏，不是硬沙箱，但这几类属于
  // 「一条命令就能落载荷并让它在下次开机/登录时自己跑」，值得无条件拦。
  [/\bcertutil(\.exe)?\b[^&|>]*\s-(urlcache|decode|decodehex)\b/i, "certutil 下载/解码载荷"],
  [/\bbitsadmin(\.exe)?\b[^&|>]*\/(transfer|addfile)\b/i, "bitsadmin 下载载荷"],
  [/\bpowershell(\.exe)?\b[^&|>]*\s-(enc|encodedcommand)\b/i, "PowerShell 编码命令"],
  [/\breg(\.exe)?\s+add\b[^&|>]*\\run(once)?(\\|"|\s|$)/i, "写注册表 Run/RunOnce 自启动"],
  [/\bwmic(\.exe)?\s+process\s+call\s+create\b/i, "wmic 远程/隐藏创建进程"],
  [/\brundll32(\.exe)?\b[^&|>]*javascript:/i, "rundll32 执行内联脚本"],
  [/\bmshta(\.exe)?\b/i, "mshta 执行内联/远程脚本"],
  [/\bschtasks(\.exe)?\b[^&|>]*\/create\b/i, "创建计划任务（持久化）"],
  [/\b(curl|wget)(\.exe)?\b[^&|>]*\|\s*(cmd|powershell|pwsh|sh|bash)\b/i, "下载后直接管道执行"],
];

// cmd 的 ^ 是转义符、引号在分词时会被吃掉：fo^rmat、f"or"mat 到 cmd 里都会还原成 format。
// 匹配前把这两类字符去掉再查一遍——黑名单是防手滑的护栏，别被这两种写法轻易绕过。
const unescapeForMatch = (cmd) => String(cmd).replace(/\^/g, "").replace(/"/g, "");

// 命中就抛错（调用方不用自己拼提示语）。任何权限模式、任何 cmd 执行路径都得先过这一关。
export function assertCommandAllowed(cmd) {
  const c = String(cmd || "");
  const probe = unescapeForMatch(c);
  for (const [re, label] of BLACKLIST) {
    if (re.test(c) || re.test(probe)) throw new Error(`命令被无条件拦截（${label}）：${c}`);
  }
}
