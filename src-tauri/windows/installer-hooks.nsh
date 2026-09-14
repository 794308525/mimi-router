!define MIMI_HOOK_DIR "${__FILEDIR__}"
!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-mimi-runtime.ps1 "${MIMI_HOOK_DIR}\stop-mimi-runtime.ps1"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\stop-mimi-runtime.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Please close Mimi Router and retry installation. Its runtime is still in use." /SD IDOK
    Abort
  ${EndIf}
!macroend
