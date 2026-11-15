# Writes one JSON line of machine readings to standard output, the first
# after a second and then one every five seconds, until its output closes:
#
#   {"cpuPercent":34.2,"cpuSpeedPercent":78.1,"gpuPercent":5.3,
#    "freeMemoryBytes":12000000000,"power":"battery","batteryPercent":41,
#    "sampledMs":1700000000000,"cpuCount":8,
#    "processes":[[4120,812,1500,1699999940000],...]}
#
# The counters are opened once and read on each sample, because starting
# PowerShell for each sample costs about 185 ms of CPU and these reads about
# 30 ms. gpuPercent is null where Windows has no GPU Engine counters,
# processes is null where it has no Process V2 counters, and batteryPercent is
# null on mains or when Windows does not know the charge.
# Each process is [pid, parentPid, cpuMs, startedMs], with CPU time summed
# over all cores and times in milliseconds since the Unix epoch.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$FIRST_SAMPLE_DELAY_MS = 1000
$SAMPLE_INTERVAL_MS = 5000
# Matches the instances of the 3D engines and captures the adapter, so each
# adapter's engines are summed apart and the busiest adapter is reported, as
# Task Manager's GPU figure is.
$GPU_3D_ENGINE_PATTERN = '_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_.*_engtype_3D$'
$UNKNOWN_BATTERY_FRACTION = 1.0
$TICKS_PER_MS = 10000
$IDLE_PID = 0

Add-Type -AssemblyName System.Windows.Forms

# Utility and Performance, not % Processor Time, are what Task Manager reads:
# both are measured against the base clock speed.
$cpuUtility = [Diagnostics.PerformanceCounter]::new('Processor Information', '% Processor Utility', '_Total')
$cpuPerformance = [Diagnostics.PerformanceCounter]::new('Processor Information', '% Processor Performance', '_Total')
$availableMemory = [Diagnostics.PerformanceCounter]::new('Memory', 'Available Bytes')
# Process V2 names each instance with its pid, so two processes of one name
# never share an instance, as they can in the Process category.
$processes = $null
if ([Diagnostics.PerformanceCounterCategory]::Exists('Process V2')) {
    $processes = [Diagnostics.PerformanceCounterCategory]::new('Process V2')
}
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
        # A missing entry reads as null, which += takes as 0.
        $adapterPercents[$adapter] += $percent
    }
    $busiest = 0.0
    foreach ($percent in $adapterPercents.Values) { $busiest = [Math]::Max($busiest, $percent) }
    return [Math]::Min(100.0, $busiest)
}

# The elapsed time counter's raw value is a process's start on a clock of
# its own, not the wall clock: read as an age, it put every start 4.8 s early
# on the machine it was measured on. This process's start is known on both
# clocks, so it converts every other start to the wall clock.
function Get-StartOffsetTicks {
    if ($null -eq $processes) { return $null }
    $self = [Diagnostics.Process]::GetCurrentProcess()
    $counters = $processes.ReadCategory()
    foreach ($instance in $counters['process id'].Keys) {
        if ($counters['process id'][$instance].RawValue -ne $self.Id) { continue }
        $startTicks = [DateTimeOffset]::new($self.StartTime).ToUnixTimeMilliseconds() * $TICKS_PER_MS
        return $startTicks - $counters['elapsed time'][$instance].RawValue
    }
    throw "Process V2 lists no instance for this sampler, pid $($self.Id)"
}

# Every process but Idle as JSON arrays, joined by hand: ConvertTo-Json takes
# several times as long over a few hundred of them. null without Process V2.
function Get-ProcessesJson($startOffsetTicks) {
    if ($null -eq $processes) { return 'null' }
    $counters = $processes.ReadCategory()
    $parents = $counters['creating process id']
    $cpuTimes = $counters['% processor time']
    $starts = $counters['elapsed time']
    $ids = $counters['process id']
    $entries = [Collections.Generic.List[string]]::new($ids.Count)
    foreach ($instance in $ids.Keys) {
        $id = $ids[$instance].RawValue
        if ($id -eq $IDLE_PID) { continue }
        $cpuMs = [Math]::Floor($cpuTimes[$instance].RawValue / $TICKS_PER_MS)
        $startedMs = [Math]::Floor(($starts[$instance].RawValue + $startOffsetTicks) / $TICKS_PER_MS)
        $entries.Add("[$id,$($parents[$instance].RawValue),$cpuMs,$startedMs]")
    }
    return '[' + ($entries -join ',') + ']'
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
$startOffsetTicks = Get-StartOffsetTicks
$delayMs = $FIRST_SAMPLE_DELAY_MS

while ($true) {
    Start-Sleep -Milliseconds $delayMs
    $delayMs = $SAMPLE_INTERVAL_MS
    $currentGpu = Read-GpuEngineSamples
    $processesJson = Get-ProcessesJson $startOffsetTicks
    $sampledMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $powerStatus = [Windows.Forms.SystemInformation]::PowerStatus
    $isOnBattery = $powerStatus.PowerLineStatus -eq [Windows.Forms.PowerLineStatus]::Offline
    $sample = [ordered]@{
        cpuPercent      = $cpuUtility.NextValue()
        cpuSpeedPercent = $cpuPerformance.NextValue()
        gpuPercent      = Get-GpuPercent $previousGpu $currentGpu
        freeMemoryBytes = $availableMemory.NextValue()
        power           = $(if ($isOnBattery) { 'battery' } else { 'mains' })
        batteryPercent  = $(if ($isOnBattery) { Get-BatteryPercent $powerStatus } else { $null })
        sampledMs       = $sampledMs
        cpuCount        = [Environment]::ProcessorCount
    }
    $previousGpu = $currentGpu
    # The machine readings end in '}', which the process list goes before.
    $machineJson = $sample | ConvertTo-Json -Compress
    $line = $machineJson.Substring(0, $machineJson.Length - 1) + ',"processes":' + $processesJson + '}'
    # A closed pipe makes the write throw, which ends the script when the
    # mod has gone without stopping it.
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}
