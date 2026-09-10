[CmdletBinding()]
param(
    [string]$Config,
    [string[]]$CopilotArgs = @('start', '--proxy-env')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entryPath = Join-Path $projectRoot 'src\index.mjs'
$statePath = Join-Path $projectRoot '.run\service.json'
$runDirectory = Join-Path $projectRoot '.run'
$nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$lockHandle = $null
$startedProcess = $null
$callerDirectory = (Get-Location).ProviderPath

function Quote-NativeArgument([string]$Value) {
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

try {
    if ([string]::IsNullOrWhiteSpace($Config)) { $configPath = Join-Path $projectRoot 'config.json' }
    elseif ([IO.Path]::IsPathRooted($Config)) { $configPath = [IO.Path]::GetFullPath($Config) }
    else { $configPath = [IO.Path]::GetFullPath((Join-Path $callerDirectory $Config)) }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing proxy config: $configPath" }
    $encodedArgs = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($CopilotArgs) -Compress)))
    $query = @'
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {loadConfig}=await import(pathToFileURL(process.argv[1]).href);
const {classifyCopilotArgs}=await import(pathToFileURL(process.argv[2]).href);
const {launchContextDigest}=await import(new URL('./launch-context.mjs',pathToFileURL(process.argv[2])));
const config=loadConfig(process.argv[3],{managedStart:true});
const args=JSON.parse(Buffer.from(process.argv[4],'base64').toString('utf8'));
if(!classifyCopilotArgs(args).managed)throw new Error('Use the foreground CLI for auth, help, debug or MCP commands.');
console.log(JSON.stringify({host:config.host,port:config.port,timeout:config.upstreamStartupTimeoutMs,argsDigest:createHash('sha256').update(JSON.stringify(args)).digest('hex'),startupContextDigest:launchContextDigest(args,process.cwd(),process.env)}));
'@
    $queryResult = & $nodePath --input-type=module -e $query (Join-Path $projectRoot 'src\config.mjs') (Join-Path $projectRoot 'src\upstream.mjs') $configPath $encodedArgs
    if ($LASTEXITCODE -ne 0) { throw 'Invalid background start configuration or command.' }
    $details = $queryResult | ConvertFrom-Json
    $configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
    $null = New-Item -ItemType Directory -Path $runDirectory -Force
    if ((Get-Item -LiteralPath $runDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing redirected .run directory.' }
    $lockHandle = [IO.File]::Open((Join-Path $runDirectory 'lifecycle.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (Test-Path -LiteralPath $statePath) {
        $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if (-not ($previous.PSObject.Properties.Name -contains 'managerPid')) { throw 'An old proxy instance is recorded. Stop v1 before starting the managed version.' }
        $existing = Get-Process -Id ([int]$previous.managerPid) -ErrorAction SilentlyContinue
        if ($null -ne $existing) {
            try {
                if ($existing.StartTime.ToUniversalTime().Ticks -ne [long]$previous.managerStartTimeUtcTicks) { throw 'The recorded manager PID was reused; no process was changed.' }
                $statusOutput = & $nodePath (Join-Path $projectRoot 'src\control.mjs') status $statePath
                if ($LASTEXITCODE -ne 0) { throw 'Recorded manager exists but does not respond. Inspect logs or stop it.' }
                $status = $statusOutput | ConvertFrom-Json
                if ($status.configSha256 -cne $configHash -or $status.argsDigest -cne $details.argsDigest -or $status.startupContextDigest -cne $details.startupContextDigest) { throw 'Service is running with different settings, working directory or environment; stop it before restarting.' }
                Write-Output "CopilotImageProxy is already $($status.status): $($status.healthUrl)"
                return
            } finally { $existing.Dispose() }
        }
        Remove-Item -LiteralPath $statePath
    }
    $nativeArgs = @($entryPath, '--config', $configPath, '--') + @($CopilotArgs)
    $argumentString = ($nativeArgs | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $startedProcess = Start-Process -FilePath $nodePath -ArgumentList $argumentString -WorkingDirectory $callerDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDirectory 'stdout.log') -RedirectStandardError (Join-Path $runDirectory 'stderr.log')
    $null = $startedProcess.Handle
    $deadline = [DateTime]::UtcNow.AddMilliseconds([double]$details.timeout + 180000)
    while ([DateTime]::UtcNow -lt $deadline) {
        $startedProcess.Refresh()
        if ($startedProcess.HasExited) { throw "Launcher exited with code $($startedProcess.ExitCode). Inspect .run\stderr.log." }
        if (Test-Path -LiteralPath $statePath) {
            $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            if ($state.launcherPid -eq $startedProcess.Id) {
                # Once the managed startup state exists, stop.ps1 can cancel npm
                # resolution or server initialization instead of waiting for readiness.
                if ($null -ne $lockHandle) { $lockHandle.Dispose(); $lockHandle = $null }
                if ($state.status -ne 'ready') { Start-Sleep -Milliseconds 250; continue }
                Write-Output "Started proxy $($state.healthUrl) with official copilot-api $($state.copilotVersion) at $($state.upstream)."
                Write-Output "Manager PID $($state.managerPid); use scripts\stop.ps1 to stop both services."
                return
            }
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Managed service did not become ready within the startup deadline.'
} catch {
    if ($null -ne $startedProcess) {
        $startedProcess.Refresh()
        if (-not $startedProcess.HasExited) {
            # This retained Process handle identifies only the launcher we just created.
            # The native supervisor notices parent exit and closes its complete Job.
            $startedProcess.Kill()
            $null = $startedProcess.WaitForExit(10000)
        }
    }
    throw
} finally {
    if ($null -ne $startedProcess) { $startedProcess.Dispose() }
    if ($null -ne $lockHandle) { $lockHandle.Dispose() }
}
