param([Parameter(Mandatory = $true)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
function Normalize-Path([string]$Value) {
    if (!$Value) { return '' }
    if ($Value.StartsWith('\\?\')) { $Value = $Value.Substring(4) }
    return [IO.Path]::GetFullPath($Value)
}
try {
    $runtimePath = Normalize-Path (Join-Path $InstallDir 'runtime\node.exe')
    $appPath = Normalize-Path (Join-Path $InstallDir 'codex-relay-router.exe')
    foreach ($targetPath in @($appPath, $runtimePath)) {
        Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and (Normalize-Path $_.ExecutablePath) -eq $targetPath
        } | ForEach-Object {
            $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($process) {
                $process.Kill()
                if (!$process.WaitForExit(10000)) { throw 'Process did not exit' }
            }
        }
    }
    if (Test-Path -LiteralPath $runtimePath) {
        $handle = [IO.File]::Open($runtimePath, 'Open', 'ReadWrite', 'None')
        $handle.Dispose()
    }
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
