# Progress reporting for Windows PowerShell 5.1. Dot-source this file, then call:
#
#   Set-Progress -Step 7 -Total 12 -Label 'compiling assets'
#
# and, in a finally block, Complete-Progress -ExitCode $code. See README.md for
# the line format. PowerShell 5.1 has no exit trap, so the finally block is the
# only way to write the finished line.

$script:ProgressCleanupMaxFiles = 500
$script:ProgressFinishedMaxAgeSeconds = 86400

function Get-ProgressEpoch {
    [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}

# A progress report must never kill the caller, so a failed write only warns.
# Failures are transient (I/O error, sharing violation while a reader has the
# file open) and the next call rewrites the whole line anyway.
function Write-ProgressLine {
    param([string]$Line)
    $tmp = "$script:ProgressFile.tmp"
    try {
        # Set-Content and Out-File write ANSI or UTF-16 in 5.1, which a reader
        # expecting UTF-8 cannot parse.
        [IO.File]::WriteAllText($tmp, "$Line`n", (New-Object Text.UTF8Encoding $false))
        if ([IO.File]::Exists($script:ProgressFile)) {
            # PowerShell turns a bare $null into an empty string for a string
            # parameter, which Replace rejects as an illegal path.
            [IO.File]::Replace($tmp, $script:ProgressFile, [NullString]::Value)
        } else {
            [IO.File]::Move($tmp, $script:ProgressFile)
        }
    } catch {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Write-Warning "progress: cannot write '$script:ProgressFile': $($_.Exception.Message)"
    }
}

# Only finished files are removed: a running file may belong to a live job, and
# a file this helper cannot parse is not its to delete. The file count is
# capped so a crowded directory cannot delay the start of a script; the
# remainder waits for the next start.
function Remove-ExpiredProgressFiles {
    if (-not [IO.Directory]::Exists($script:ProgressDir)) { return }
    $now = Get-ProgressEpoch
    $examined = 0
    foreach ($path in [IO.Directory]::EnumerateFiles($script:ProgressDir, '*.txt')) {
        # The *.txt filter also matches longer extensions such as .txtx.
        if (-not $path.EndsWith('.txt', [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($examined -ge $script:ProgressCleanupMaxFiles) { break }
        $examined++
        try {
            $parts = [IO.File]::ReadAllText($path).TrimEnd("`n").Split(' ')
            if ($parts.Count -eq 4 -and $parts[1] -ceq 'done' -and
                # Windows reports a crashed process with a negative exit code.
                $parts[0] -match '^[0-9]+$' -and $parts[2] -match '^-?[0-9]+$' -and
                $parts[3] -match '^[0-9]{1,15}$' -and
                ($now - [long]$parts[3]) -gt $script:ProgressFinishedMaxAgeSeconds) {
                [IO.File]::Delete($path)
            }
        } catch [IO.IOException], [UnauthorizedAccessException] {
            # A reader or another script holds the file, or deleted it first, or
            # it is not this user's to read; the next start retries.
            continue
        }
    }
}

function Set-Progress {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Step,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Total,
        [string]$Label = ''
    )
    # Validation is manual because a typed parameter's binding error does not
    # use the message shape shared with the Bash helper.
    if ($Step -notmatch '^[0-9]+$' -or $Total -notmatch '^[0-9]+$') {
        throw "progress: expected non-negative integers for step and total, got '$Step' '$Total'"
    }
    $text = $Label -replace '[\r\n\t]', ' '
    if ($text.Length -gt 0) { $text = " $text" }
    Write-ProgressLine "$script:ProgressStarted $Step $Total$text"
}

function Complete-Progress {
    param([Parameter(Mandatory)][int]$ExitCode)
    Write-ProgressLine "$script:ProgressStarted done $ExitCode $(Get-ProgressEpoch)"
}

$script:ProgressName = if ($MyInvocation.PSCommandPath) {
    Split-Path -Leaf $MyInvocation.PSCommandPath
} else {
    'powershell'
}
$script:ProgressDir = if ($env:CLAUDE_PROGRESS_DIR) {
    $env:CLAUDE_PROGRESS_DIR
} else {
    Join-Path (Get-Location).ProviderPath '.claude/progress'
}
$script:ProgressDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($script:ProgressDir)
$script:ProgressFile = Join-Path $script:ProgressDir "$script:ProgressName-$PID.txt"
$script:ProgressStarted = Get-ProgressEpoch

try {
    [void][IO.Directory]::CreateDirectory($script:ProgressDir)
} catch {
    Write-Warning "progress: cannot create '$script:ProgressDir': $($_.Exception.Message)"
}
Remove-ExpiredProgressFiles
