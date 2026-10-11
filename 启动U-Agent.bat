@echo off
title u-agent - U盘便携AI助手
cd /d "%~dp0"
if not exist "runtime\node\node.exe" (
  echo.
  echo  [u-agent] 还没装运行环境，正在自动安装（需联网，约 1 分钟）...
  echo.
  call setup-uagent.bat
)
if not exist "runtime\node\node.exe" (
  echo.
  echo  [u-agent] 运行环境没装好。请检查网络后重跑 setup-uagent.bat，
  echo            或手动把 node-v22.21.1-win-x64.zip 解压到 runtime\node\
  echo.
  pause
  exit /b 1
)
"runtime\node\node.exe" launcher.mjs
if errorlevel 1 (
  echo.
  echo  [u-agent] 服务异常退出，详见上方日志。
  echo.
  pause
)
