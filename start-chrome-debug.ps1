# Start Chrome in remote-debugging mode for chrome-devtools-mcp (port 9222).
# Usage: powershell -ExecutionPolicy Bypass -File start-chrome-debug.ps1
# Note: uses an isolated user-data-dir so it won't conflict with your normal Chrome.

Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$udp = "D:\Y\WY\2026\jsona\.chrome-debug-profile"
if (-not (Test-Path $udp)) { New-Item -ItemType Directory -Path $udp | Out-Null }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$psi.Arguments = "--remote-debugging-port=9222 --user-data-dir=$udp --no-first-run --no-default-browser-check"
$psi.UseShellExecute = $false
$p = [System.Diagnostics.Process]::Start($psi)
Write-Host ("Chrome launched (pid=" + $p.Id + "). DevTools on http://127.0.0.1:9222")
