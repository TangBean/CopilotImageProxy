[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runDirectory = Join-Path $projectRoot '.run'
$statePath = Join-Path $runDirectory 'service.json'
$managerPath = Join-Path $projectRoot 'bin\JobHost.exe'
$lockHandle = $null
$manager = $null
try {
    if (-not (Test-Path -LiteralPath $runDirectory -PathType Container)) { Write-Output 'No managed service is recorded.'; return }
    if ((Get-Item -LiteralPath $runDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing redirected .run directory.' }
    $lockHandle = [IO.File]::Open((Join-Path $runDirectory 'lifecycle.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'No managed service is recorded.'; return }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if (-not [string]::Equals([string]$state.managerPath, $managerPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The recorded manager does not belong to this project.' }
    $manager = Get-Process -Id ([int]$state.managerPid) -ErrorAction SilentlyContinue
    if ($null -eq $manager) { Remove-Item -LiteralPath $statePath; Write-Output 'Manager already exited; stale state removed.'; return }
    $null = $manager.Handle
    if ($manager.StartTime.ToUniversalTime().Ticks -ne [long]$state.managerStartTimeUtcTicks -or
        -not [string]::Equals($manager.Path, $managerPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The manager identity does not match; no process was stopped.'
    }
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    & $nodePath (Join-Path $projectRoot 'src\control.mjs') stop $statePath
    if ($LASTEXITCODE -ne 0) {
        # The retained handle pins this already-verified process instance.
        # Its exit closes the Job even when the control channel has failed.
        $manager.Refresh()
        if (-not $manager.HasExited) { $manager.Kill() }
    }
    if (-not $manager.WaitForExit(10000)) { throw 'The manager did not exit in time; state was retained.' }
    if (Test-Path -LiteralPath $statePath) {
        $current = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($current.runId -eq $state.runId) { Remove-Item -LiteralPath $statePath }
    }
} finally {
    if ($null -ne $manager) { $manager.Dispose() }
    if ($null -ne $lockHandle) { $lockHandle.Dispose() }
}
