@echo off
rem ============================================================================
rem  双击启动 DeepSeek Chat（开发期形态）
rem
rem  它做的事：
rem    1) 固定 DSK_USERDATA → 复用已登录的数据目录（免去每次重新登录）；
rem    2) 用 start /min 把应用放进**独立的最小化控制台**运行 ——
rem       这样本窗口会立刻退出，你关掉它也不会连累应用；
rem    3) 日志写到 logs\app.log（每次启动覆盖），出问题时把这个文件发我。
rem
rem  退出应用：托盘图标右键 → 退出（点窗口 X 只是隐藏到托盘）。
rem  那个最小化的控制台窗口请不要关（关掉=退出应用），最小化放着即可。
rem ============================================================================
setlocal
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
set "DSK_USERDATA=%~dp0.spike-userdata-main"
rem 启动前清掉历史残留的控制台（只清"不承载正在运行的应用"的那些，见该脚本注释）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\clean-consoles.ps1"
start "DeepSeek Chat" /min "%~dp0scripts\run-app.cmd"
