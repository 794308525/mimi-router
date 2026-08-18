!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$nodePath = [System.IO.Path]::GetFullPath(''$INSTDIR\runtime\node.exe''); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -eq $$nodePath } | ForEach-Object { $$targetProcessId = $$_.ProcessId; Stop-Process -Id $$targetProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $$targetProcessId -Timeout 5 -ErrorAction SilentlyContinue }"'
!macroend
