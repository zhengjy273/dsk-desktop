# 清理残留的「启动控制台」。
#
# 背景（实测坑）：Windows 的 `start "标题" /min "某个.cmd"` 会用 **cmd /K** 启动，
# 即"执行完不退出" —— 应用每次重启/退出都会残留一个控制台窗口，堆积成一排。
# 改用 `cmd /c` 虽然不残留，但实测应用会随控制台一起退出（不稳定）。
#
# 因此策略是：**保留 /K 的稳定性 + 启动前清理残留**。
# 安全约束：只清理命令行含 `run-app.cmd` 的 cmd，且**跳过承载当前应用的那个**
#（通过 electron → node → cmd 的父子链动态定位），绝不误杀正在运行的应用。

$ErrorActionPreference = 'SilentlyContinue'

$electron = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select-Object -First 1
$keepCmd = $null
if ($electron) {
  $node = Get-CimInstance Win32_Process -Filter "ProcessId=$($electron.ParentProcessId)"
  if ($node) { $keepCmd = $node.ParentProcessId }
}

$orphans = @(
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -like '*run-app.cmd*' -and $_.ProcessId -ne $keepCmd }
)

foreach ($p in $orphans) {
  Stop-Process -Id $p.ProcessId -Force
}

if ($orphans.Count -gt 0) {
  Write-Host "[clean] 清理残留控制台 $($orphans.Count) 个（保留承载应用的 PID=$keepCmd）"
} else {
  Write-Host '[clean] 没有残留控制台需要清理'
}
