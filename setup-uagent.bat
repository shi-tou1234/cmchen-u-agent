@echo off
cd /d "%~dp0"
if exist "runtime\node\node.exe" goto have_node
where node >nul 2>nul
if errorlevel 1 goto no_node
set "NODE_EXE=node"
goto run
:have_node
set "NODE_EXE=runtime\node\node.exe"
goto run
:no_node
echo.
echo  [u-agent] 没找到 node.exe（runtime\node 和系统 PATH 都没有）。
echo  [u-agent] 请先在这台电脑安装 Node.js，或把便携 node 放到 runtime\node\node.exe
echo.
pause
exit /b 1
:run
%NODE_EXE% setup.mjs %*
if errorlevel 1 pause
