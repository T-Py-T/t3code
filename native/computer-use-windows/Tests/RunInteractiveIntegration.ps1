param(
    [Parameter(Mandatory = $true)]
    [string] $HelperPath,

    [Parameter(Mandatory = $true)]
    [string] $OutputPath
)

$ErrorActionPreference = "Stop"
$marker = "T3 Code Windows Computer Use integration passed."
$responses = [System.Collections.Generic.List[string]]::new()
$progressPath = "$OutputPath.progress"
"starting" | Set-Content -Encoding utf8 $progressPath

function Assert-Condition {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw $Message }
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $HelperPath
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true
$helper = [System.Diagnostics.Process]::new()
$helper.StartInfo = $startInfo
$helperStarted = $false

function Invoke-HostRequest {
    param(
        [string] $Operation,
        [hashtable] $Payload,
        [string] $TargetId = $null,
        [string] $ObservationId = $null
    )

    $requestId = [guid]::NewGuid().ToString("N")
    $leaseId = "integration-$requestId"
    $request = @{
        type = "request"
        request = @{
            requestId = $requestId
            leaseId = $leaseId
            environmentId = "utm-windows11-interactive"
            operation = $Operation
            input = $Payload
            timeoutMs = 30000
        }
    }
    if ($TargetId) { $request.request.targetId = $TargetId }
    if ($ObservationId) { $request.request.observationId = $ObservationId }
    "sending $Operation" | Add-Content -Encoding utf8 $progressPath
    $helper.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 20 -Compress))
    $helper.StandardInput.Flush()
    $line = $helper.StandardOutput.ReadLine()
    "received $Operation" | Add-Content -Encoding utf8 $progressPath
    Assert-Condition ($null -ne $line) "The helper closed before responding to $Operation."
    $responses.Add($line)
    $response = $line | ConvertFrom-Json
    Assert-Condition ($response.ok -eq $true) "The helper rejected ${Operation}: $($response.error.message)"
    return $response
}

try {
    Start-Process "$env:WINDIR\System32\notepad.exe"
    Start-Sleep -Seconds 3
    Assert-Condition ($helper.Start()) "The Windows Computer Use helper did not start."
    $helperStarted = $true
    "helper started" | Add-Content -Encoding utf8 $progressPath

    $status = Invoke-HostRequest -Operation "status" -Payload @{}
    Assert-Condition ($status.result.locked -eq $false) "The interactive desktop was reported as locked."

    $targets = Invoke-HostRequest -Operation "listTargets" -Payload @{}
    $target = $targets.result.targets | Where-Object {
        $_.applicationId -like "Microsoft.WindowsNotepad_*"
    } | Select-Object -First 1
    Assert-Condition ($null -ne $target) "Notepad was not discovered as a Computer Use target."

    $screenshotObservation = Invoke-HostRequest -Operation "observe" -TargetId $target.targetId -Payload @{
        includeScreenshot = $true
        includeAccessibility = $false
    }
    Assert-Condition ($screenshotObservation.result.screenshot.mimeType -eq "image/png") "The observation did not contain a PNG screenshot."
    Assert-Condition ($screenshotObservation.result.screenshot.base64.Length -gt 1000) "The screenshot payload was unexpectedly small."

    $observe = Invoke-HostRequest -Operation "observe" -TargetId $target.targetId -Payload @{
        includeScreenshot = $false
        includeAccessibility = $true
    }
    Assert-Condition ($observe.result.elements.Count -gt 0) "The observation did not contain accessibility elements."

    $document = $observe.result.elements | Where-Object {
        $_.role -eq "document" -and $null -ne $_.frame
    } | Select-Object -First 1
    Assert-Condition ($null -ne $document) "Notepad did not expose an actionable document element."
    $x = [int][Math]::Min(
        [Math]::Max(1, $document.frame.x + [Math]::Floor($document.frame.width / 2)),
        $observe.result.width - 1
    )
    $y = [int][Math]::Min(
        [Math]::Max(1, $document.frame.y + [Math]::Floor($document.frame.height / 2)),
        $observe.result.height - 1
    )

    $act = Invoke-HostRequest -Operation "act" -TargetId $target.targetId -ObservationId $observe.result.observationId -Payload @{
        actions = @(
            @{ _tag = "click"; x = $x; y = $y },
            @{ _tag = "keypress"; key = "a"; modifiers = @("control"); phase = "press" },
            @{ _tag = "text-entry"; text = "T3" },
            @{ _tag = "paste"; text = $marker.Substring(2) },
            @{ _tag = "wait"; durationMs = 250 }
        )
    }
    Assert-Condition ($act.result.completedActions -eq 5) "The action sequence was incomplete."
    Assert-Condition ($act.result.observation.screenshot.base64.Length -gt 1000) "The post-action screenshot was missing."
    $written = $act.result.observation.elements | Where-Object {
        $_.value -like "*$marker*"
    } | Select-Object -First 1
    Assert-Condition ($null -ne $written) "Notepad did not expose the text written by Computer Use."

    [pscustomobject]@{
        passed = $true
        target = $target
        observationId = $observe.result.observationId
        postActionObservationId = $act.result.observation.observationId
        completedActions = $act.result.completedActions
        accessibilityElementCount = $act.result.observation.elements.Count
        screenshotBytes = [Convert]::FromBase64String(
            $act.result.observation.screenshot.base64
        ).Length
        marker = $marker
        responses = $responses
    } | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $OutputPath
    "passed" | Add-Content -Encoding utf8 $progressPath
}
catch {
    [pscustomobject]@{
        passed = $false
        error = $_.Exception.Message
        responses = $responses
    } | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 "$OutputPath.failure"
    throw
}
finally {
    if ($helperStarted) {
        if (-not $helper.HasExited) {
            $helper.StandardInput.Close()
            $helper.WaitForExit(5000) | Out-Null
        }
        $stderr = $helper.StandardError.ReadToEnd()
        if ($stderr) { Write-Error $stderr }
    }
    $helper.Dispose()
}
