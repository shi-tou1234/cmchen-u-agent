// u-agent 环境安装器：下载便携 node 到 U 盘 runtime\node（幂等，--force 重装）
// 零 npm 依赖；zip 解压用系统自带 tar（Win10 1803+），失败退回 PowerShell Expand-Archive
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = path.dirname(fileURLToPath(import.meta.url));
const VER = JSON.parse(fs.readFileSync(path.join(HOME, "VERSIONS.json"), "utf8")).node;
const NODE_DIR = path.join(HOME, "runtime", "node");
const NODE_EXE = path.join(NODE_DIR, "node.exe");
const CACHE = path.join(HOME, "data", "cache");
const ZIP_NAME = `node-v${VER}-win-x64.zip`;
const URL_ = `https://registry.npmmirror.com/-/binary/node/v${VER}/${ZIP_NAME}`;
const SUMS_URL = `https://registry.npmmirror.com/-/binary/node/v${VER}/SHASUMS256.txt`;
const EXPECT_SIZE = 35556042; // 2026-10-11 实测

const log = (...a) => console.log("[u-agent]", ...a);

// 供应链校验（审查二轮 #17）：拿官方 SHASUMS256.txt 比对 sha256。
// 校验做不成（清单拉不到）时降级为大小校验并明确提示；对不上则删包重来。
async function verifyZip(zip) {
  try {
    const res = await fetch(SUMS_URL, { redirect: "follow" });
    if (!res.ok) throw new Error("清单 HTTP " + res.status);
    const line = (await res.text()).split(/\r?\n/).find((l) => l.trim().endsWith(ZIP_NAME));
    if (!line) throw new Error("清单里没有 " + ZIP_NAME);
    const want = line.trim().split(/\s+/)[0].toLowerCase();
    const got = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
    if (want !== got) {
      fs.rmSync(zip, { force: true });
      throw new Error(`sha256 不符（期望 ${want.slice(0, 12)}… 实得 ${got.slice(0, 12)}…），已删除缓存包，请重试`);
    }
    log("sha256 校验通过（对 npmmirror SHASUMS256.txt）");
  } catch (e) {
    log(`⚠ 没做成哈希校验（${e.message}），退回大小校验——包来自 npmmirror 官方源，仍可用；介意的话带 --force 重装重试`);
  }
}

function nodeVersion(exe) {
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function main() {
  const force = process.argv.slice(2).some((a) => /^--?force$/i.test(a));
  if (force && fs.existsSync(path.join(HOME, "runtime"))) {
    log("force：删除旧 runtime …");
    fs.rmSync(path.join(HOME, "runtime"), { recursive: true, force: true });
  }

  if (fs.existsSync(NODE_EXE)) {
    const v = nodeVersion(NODE_EXE);
    if (v === `v${VER}`) {
      log(`已就绪（runtime\\node ${v}），无需安装。需要重装请加 force 参数。`);
      return;
    }
    log(`现有 node 版本 ${v} ≠ v${VER}，重装 …`);
    fs.rmSync(path.join(HOME, "runtime"), { recursive: true, force: true });
  }

  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, ZIP_NAME);

  if (!fs.existsSync(zip) || fs.statSync(zip).size < EXPECT_SIZE * 0.9) {
    log(`下载便携 node v${VER}（约 34MB）…\n  ${URL_}`);
    const res = await fetch(URL_, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}——请检查网络后重试`);
    const total = Number(res.headers.get("content-length")) || 0;
    const buf = Buffer.from(await res.arrayBuffer());
    if (total && Math.abs(buf.length - total) > 1024) throw new Error(`下载不完整 ${buf.length}/${total}`);
    log(`下载完成 ${(buf.length / 1048576).toFixed(1)}MB，写入缓存 …`);
    fs.writeFileSync(zip, buf);
  } else {
    log("缓存里已有完整 zip，跳过下载");
  }
  await verifyZip(zip);

  fs.mkdirSync(NODE_DIR, { recursive: true });
  log("解压到 runtime\\node（U 盘小文件写入，约 1-2 分钟）…");
  extractZip(zip, NODE_DIR);

  const exe = path.join(NODE_DIR, "node.exe");
  if (!fs.existsSync(exe)) throw new Error("解压后没找到 node.exe——请把压缩包手动解压到 runtime\\node");
  const v = nodeVersion(exe);
  if (v !== `v${VER}`) throw new Error(`node 版本校验失败：得到 ${v}，期望 v${VER}`);
  fs.rmSync(zip, { force: true });
  log(`装好了：runtime\\node ${v}`);
  log("现在可以双击「启动U-Agent.bat」了。");
}

function extractZip(zip, dest) {
  // 优先系统 tar（bsdtar 能识别 zip），失败退回 PowerShell
  let r = spawnSync("tar", ["-xf", zip, "-C", dest], { timeout: 600000 });
  if (r.status === 0 && fs.existsSync(path.join(dest, "node.exe"))) return;
  log("tar 解压不可用，改用 PowerShell Expand-Archive …");
  r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
    { timeout: 900000 }
  );
  // Expand-Archive 会多包一层 node-vX.Y.Z 目录，把内容提上来
  const inner = path.join(dest, `node-v${VER}-win-x64`);
  if (fs.existsSync(inner) && !fs.existsSync(path.join(dest, "node.exe"))) {
    for (const f of fs.readdirSync(inner)) fs.renameSync(path.join(inner, f), path.join(dest, f));
    fs.rmdirSync(inner);
  }
  if (!fs.existsSync(path.join(dest, "node.exe"))) throw new Error("解压失败（tar 与 PowerShell 都不行）");
}

main().catch((e) => {
  console.error("[u-agent] 安装失败：", e.message);
  process.exit(1);
});
