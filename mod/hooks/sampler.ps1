# Writes one JSON line of machine readings to standard output, the first
# after a second and then one every five seconds, until its output closes:
#
#   {"cpuPercent":34.2,"cpuSpeedPercent":78.1,"gpuPercent":5.3,
#    "freeMemoryBytes":12000000000,"power":"battery","batteryPercent":41}
#
# The counters are opened once and read on each sample, because starting
# PowerShell for each sample costs about 185 ms of CPU and these reads about
# 20 ms. gpuPercent is null where Windows has no GPU Engine counters, and
# batteryPercent is null on mains or when Windows does not know the charge.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$FIRST_SAMPLE_DELAY_MS = 1000
$SAMPLE_INTERVAL_MS = 5000
# Matches the instances of the 3D engines and captures the adapter, so each
# adapter's engines are summed apart and the busiest adapter is reported, as
# Task Manager's GPU figure is.
$GPU_3D_ENGINE_PATTERN = '_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_.*_engtype_3D$'
$UNKNOWN_BATTERY_FRACTION = 1.0

Add-Type -AssemblyName System.Windows.Forms

# Utility and Performance, not % Processor Time, are what Task Manager reads:
# both are measured against the base clock speed.
$cpuUtility = [Diagnostics.PerformanceCounter]::new('Processor Information', '% Processor Utility', '_Total')
$cpuPerformance = [Diagnostics.PerformanceCounter]::new('Processor Information', '% Processor Performance', '_Total')
$availableMemory = [Diagnostics.PerformanceCounter]::new('Memory', 'Available Bytes')
$gpuEngines = $null
if ([Diagnostics.PerformanceCounterCategory]::Exists('GPU Engine')) {
    $gpuEngines = [Diagnostics.PerformanceCounterCategory]::new('GPU Engine')
}

function Read-GpuEngineSamples {
    if ($null -eq $gpuEngines) { return $null }
    return $gpuEngines.ReadCategory()['Utilization Percentage']
}

# The busiest adapter's 3D engines between two readings, in percent; null
# without GPU counters. An engine missing from either reading started or
# ended between them and is left out.
function Get-GpuPercent($previous, $current) {
    if ($null -eq $previous -or $null -eq $current) { return $null }
    $adapterPercents = @{}
    foreach ($instance in $current.Keys) {
        if ($instance -notmatch $GPU_3D_ENGINE_PATTERN) { continue }
        $before = $previous[$instance]
        if ($null -eq $before) { continue }
        $adapter = $Matches[1]
        $percent = [Diagnostics.CounterSample]::Calculate($before.Sample, $current[$instance].Sample)
        $adapterPercents[$adapter] = $percent + $(if ($adapterPercents.ContainsKey($adapter)) { $adapterPercents[$adapter] } else { 0.0 })
    }
    $busiest = 0.0
    foreach ($percent in $adapterPercents.Values) { $busiest = [Math]::Max($busiest, $percent) }
    return [Math]::Min(100.0, $busiest)
}

function Get-BatteryPercent($powerStatus) {
    $fraction = $powerStatus.BatteryLifePercent
    if ($fraction -gt $UNKNOWN_BATTERY_FRACTION) { return $null }
    return [Math]::Round($fraction * 100)
}

# The first read of a rate counter is always 0, so each is read once here.
[void]$cpuUtility.NextValue()
[void]$cpuPerformance.NextValue()
$previousGpu = Read-GpuEngineSamples
$delayMs = $FIRST_SAMPLE_DELAY_MS

while ($true) {
    Start-Sleep -Milliseconds $delayMs
    $delayMs = $SAMPLE_INTERVAL_MS
    $currentGpu = Read-GpuEngineSamples
    $powerStatus = [Windows.Forms.SystemInformation]::PowerStatus
    $isOnBattery = $powerStatus.PowerLineStatus -eq [Windows.Forms.PowerLineStatus]::Offline
    $sample = [ordered]@{
        cpuPercent      = $cpuUtility.NextValue()
        cpuSpeedPercent = $cpuPerformance.NextValue()
        gpuPercent      = Get-GpuPercent $previousGpu $currentGpu
        freeMemoryBytes = $availableMemory.NextValue()
        power           = $(if ($isOnBattery) { 'battery' } else { 'mains' })
        batteryPercent  = $(if ($isOnBattery) { Get-BatteryPercent $powerStatus } else { $null })
    }
    $previousGpu = $currentGpu
    # A closed pipe makes the write throw, which ends the script when the
    # mod has gone without stopping it.
    [Console]::Out.WriteLine(($sample | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}
