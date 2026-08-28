param(
  [Parameter(Mandatory = $true)][string]$AppExecutable,
  [Parameter(Mandatory = $true)][string]$ExpectedHelperSha256,
  [string]$EvidenceDirectory = "C:\Users\Public\t3-package-acceptance",
  [int]$ProbeTimeoutSeconds = 120,
  [switch]$RequireValidHelperSignature,
  [switch]$RequireRunningApp,
  [switch]$RequireRunningHelper
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($null -eq ("T3Code.ComputerUse.Tests.ProcessNativeMethods" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace T3Code.ComputerUse.Tests
{
    public static class ProcessNativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    }
}
'@
}

function Assert-T3Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Invoke-T3NodeProbe {
  param(
    [string]$Executable,
    [string[]]$Arguments,
    [string]$Label,
    [string]$OutputDirectory,
    [int]$TimeoutSeconds
  )

  $stdoutPath = Join-Path $OutputDirectory ($Label + ".stdout.txt")
  $stderrPath = Join-Path $OutputDirectory ($Label + ".stderr.txt")
  $quotedArguments = $Arguments | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\\"') + '"' } else { $_ }
  }

  $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $previousNodePath = $env:NODE_PATH
  $previousNodeOptions = $env:NODE_OPTIONS
  $previousNoAsar = $env:ELECTRON_NO_ASAR
  $process = $null
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    $env:NODE_PATH = ""
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:ELECTRON_NO_ASAR -ErrorAction SilentlyContinue
    $process = Start-Process `
      -FilePath $Executable `
      -ArgumentList $quotedArguments `
      -WorkingDirectory (Split-Path $Executable -Parent) `
      -PassThru `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath
    [IntPtr]$processHandle = $process.Handle
    if ($processHandle -eq [IntPtr]::Zero) {
      throw "$Label did not expose a process handle."
    }
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "$Label timed out after $TimeoutSeconds seconds."
    }
    [void]$process.WaitForExit()
    $process.Refresh()
    [uint32]$exitCode = 0
    $hasExitCode = [T3Code.ComputerUse.Tests.ProcessNativeMethods]::GetExitCodeProcess(
      $processHandle,
      [ref]$exitCode
    )
    if (-not $hasExitCode) {
      $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "$Label could not read the process exit code. Win32 error=$nativeError"
    }
    if ($exitCode -eq 259) {
      throw "$Label reported that the process was still active after it exited."
    }
    if ($exitCode -ne 0) {
      $stderr = Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue
      $stdout = Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue
      throw "$Label failed with exit code $exitCode. stderr=$stderr stdout=$stdout"
    }
    return [pscustomobject]@{
      label = $Label
      exitCode = $exitCode
      stdoutPath = $stdoutPath
      stderrPath = $stderrPath
    }
  } finally {
    if ($null -ne $process) { $process.Dispose() }
    if ($null -eq $previousRunAsNode) {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    } else {
      $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
    }
    if ($null -eq $previousNodePath) {
      Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    } else {
      $env:NODE_PATH = $previousNodePath
    }
    if ($null -eq $previousNodeOptions) {
      Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    } else {
      $env:NODE_OPTIONS = $previousNodeOptions
    }
    if ($null -eq $previousNoAsar) {
      Remove-Item Env:ELECTRON_NO_ASAR -ErrorAction SilentlyContinue
    } else {
      $env:ELECTRON_NO_ASAR = $previousNoAsar
    }
  }
}

Assert-T3Condition ($ProbeTimeoutSeconds -ge 1 -and $ProbeTimeoutSeconds -le 900) `
  "ProbeTimeoutSeconds must be between 1 and 900."
$evidenceFullPath = [IO.Path]::GetFullPath($EvidenceDirectory)
$evidenceRoot = [IO.Path]::GetPathRoot($evidenceFullPath)
$evidenceLeaf = Split-Path $evidenceFullPath -Leaf
Assert-T3Condition ($evidenceFullPath -ne $evidenceRoot) `
  "EvidenceDirectory must not be a drive root."
Assert-T3Condition ($evidenceLeaf -match '^t3-.*acceptance') `
  "EvidenceDirectory must use a dedicated t3-*-acceptance directory."

if (Test-Path -LiteralPath $evidenceFullPath) {
  Remove-Item -LiteralPath $evidenceFullPath -Recurse -Force
}
New-Item -ItemType Directory -Path $evidenceFullPath | Out-Null

$appPath = (Resolve-Path -LiteralPath $AppExecutable).Path
$installDirectory = Split-Path $appPath -Parent
$resourcesDirectory = Join-Path $installDirectory "resources"
$helperPath = Join-Path $resourcesDirectory "computer-use\T3CodeComputerUse.exe"
$resourceMonitorPath = Join-Path $resourcesDirectory "resource-monitor\t3-resource-monitor.exe"
$serverAsarPath = Join-Path $resourcesDirectory "server.asar"
$serverEntryPath = Join-Path $serverAsarPath "apps\server\dist\bin.mjs"
$fffEntryPath = Join-Path $serverAsarPath "node_modules\@ff-labs\fff-node\dist\src\index.js"

Assert-T3Condition (Test-Path -LiteralPath $appPath -PathType Leaf) `
  "Packaged T3 executable is missing: $appPath"
Assert-T3Condition (Test-Path -LiteralPath $helperPath -PathType Leaf) `
  "Computer Use helper is missing: $helperPath"
Assert-T3Condition (Test-Path -LiteralPath $resourceMonitorPath -PathType Leaf) `
  "Resource monitor is missing: $resourceMonitorPath"
Assert-T3Condition (Test-Path -LiteralPath $serverAsarPath -PathType Leaf) `
  "Server sidecar is missing: $serverAsarPath"

$helperHash = (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToUpperInvariant()
Assert-T3Condition ($helperHash -eq $ExpectedHelperSha256.ToUpperInvariant()) `
  "Computer Use helper hash mismatch: $helperHash"

$helperSignature = Get-AuthenticodeSignature -LiteralPath $helperPath
if ($RequireValidHelperSignature) {
  Assert-T3Condition `
    ($helperSignature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) `
    "Computer Use helper signature is not valid: $($helperSignature.Status)"
  Assert-T3Condition ($null -ne $helperSignature.SignerCertificate) `
    "Computer Use helper has no signing certificate."
}

$probeRoot = Join-Path $evidenceFullPath "fff-probe-root"
New-Item -ItemType Directory -Path $probeRoot | Out-Null
$fffProbePath = Join-Path $evidenceFullPath "fff-probe.mjs"
@'
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { FileFinder } = await import(pathToFileURL(process.argv[2]).href);
const probeRoot = process.argv[3];
const result = FileFinder.create({
  basePath: probeRoot,
  frecencyDbPath: join(probeRoot, "frecency.mdb"),
  historyDbPath: join(probeRoot, "history.mdb"),
  disableWatch: true,
  disableMmapCache: true,
  disableContentIndexing: true,
});
if (!result.ok) throw new Error(result.error);
result.value.destroy();
'@ | Set-Content -LiteralPath $fffProbePath -Encoding UTF8

$serverProbe = Invoke-T3NodeProbe `
  -Executable $appPath `
  -Arguments @("--no-global-search-paths", $serverEntryPath, "--version") `
  -Label "server-sidecar" `
  -OutputDirectory $evidenceFullPath `
  -TimeoutSeconds $ProbeTimeoutSeconds
$fffProbe = Invoke-T3NodeProbe `
  -Executable $appPath `
  -Arguments @("--no-global-search-paths", $fffProbePath, $fffEntryPath, $probeRoot) `
  -Label "fff-native" `
  -OutputDirectory $evidenceFullPath `
  -TimeoutSeconds $ProbeTimeoutSeconds

$appProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -eq $appPath
} | Select-Object ProcessId,SessionId,ExecutablePath,CommandLine)
$helperProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -eq $helperPath
} | Select-Object ProcessId,ParentProcessId,SessionId,ExecutablePath,CommandLine)
if ($RequireRunningApp) {
  Assert-T3Condition ($appProcesses.Count -gt 0) "The packaged T3 app is not running."
}
if ($RequireRunningHelper) {
  Assert-T3Condition ($helperProcesses.Count -gt 0) `
    "The packaged Computer Use helper is not running."
}
$attachedHelperProcesses = @()
if ($RequireRunningApp -and $RequireRunningHelper) {
  $appProcessIds = @($appProcesses | ForEach-Object ProcessId)
  $appSessionIds = @($appProcesses | ForEach-Object SessionId | Select-Object -Unique)
  $attachedHelperProcesses = @($helperProcesses | Where-Object {
    $appProcessIds -contains $_.ParentProcessId -and $appSessionIds -contains $_.SessionId
  })
  Assert-T3Condition ($attachedHelperProcesses.Count -gt 0) `
    "No packaged Computer Use helper is attached to the running T3 app session."
}

$operatingSystem = Get-CimInstance Win32_OperatingSystem |
  Select-Object Caption,Version,BuildNumber,OSArchitecture,LastBootUpTime
$computerSystem = Get-CimInstance Win32_ComputerSystem |
  Select-Object Manufacturer,Model,SystemType,TotalPhysicalMemory
$videoControllers = @(Get-CimInstance Win32_VideoController |
  Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate)
$signerSubject = if ($null -eq $helperSignature.SignerCertificate) {
  $null
} else {
  $helperSignature.SignerCertificate.Subject
}
$evidence = [ordered]@{
  status = "passed"
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  appExecutable = $appPath
  appVersion = (Get-Item -LiteralPath $appPath).VersionInfo.FileVersion
  helperPath = $helperPath
  helperSha256 = $helperHash
  helperSignatureStatus = [string]$helperSignature.Status
  helperSignerSubject = $signerSubject
  resourceMonitorPath = $resourceMonitorPath
  serverAsarPath = $serverAsarPath
  serverProbe = $serverProbe
  fffProbe = $fffProbe
  appProcesses = $appProcesses
  helperProcesses = $helperProcesses
  attachedHelperProcesses = $attachedHelperProcesses
  operatingSystem = $operatingSystem
  computerSystem = $computerSystem
  videoControllers = $videoControllers
}
$evidencePath = Join-Path $evidenceFullPath "acceptance.json"
$evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
$evidence | ConvertTo-Json -Depth 8
