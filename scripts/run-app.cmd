@echo off
rem ============================================================================
rem  内部启动脚本（由「启动 DeepSeek Chat.cmd」用 start /min 调用）
rem
rem  为什么单独一层：应用需要在一个**独立的最小化控制台**里运行 ——
rem  否则用户关闭启动窗口时会连带把应用一起杀掉（实测 ^C 终止）。
rem
rem  必须经 scripts/launch.mjs：它会
rem    1) 清掉 DSH 注入的 ELECTRON_RUN_AS_NODE=1（否则 Electron 退化成 Node 模式）；
rem    2) 把 Electron 指向"干净 ACL 目录"里的 dist（否则 Chromium 沙箱起不来）。
rem ============================================================================
setlocal
cd /d "%~dp0.."
rem 保留上一轮日志：直接覆盖会让"上次崩溃/异常"无从追溯
if exist "%~dp0..\logs\app.log" move /Y "%~dp0..\logs\app.log" "%~dp0..\logs\app.prev.log" >nul
node "%~dp0launch.mjs" "%~dp0..\src\main\main.ts" > "%~dp0..\logs\app.log" 2>&1
