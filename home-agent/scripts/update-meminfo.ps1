# Script to write Windows host memory info for Docker container
# Run this periodically (e.g., via Task Scheduler every minute)

$memInfo = Get-CimInstance Win32_OperatingSystem
$totalMem = $memInfo.TotalVisibleMemorySize  # in KB
$freeMem = $memInfo.FreePhysicalMemory        # in KB

$content = @"
MemTotal:       $totalMem kB
MemFree:        $freeMem kB
MemAvailable:   $freeMem kB
"@

$outputPath = "C:\docker-volumes\host-meminfo"
if (-not (Test-Path (Split-Path $outputPath))) {
    New-Item -ItemType Directory -Path (Split-Path $outputPath) -Force | Out-Null
}

# Write UTF8 without BOM
[System.IO.File]::WriteAllText($outputPath, $content, [System.Text.UTF8Encoding]::new($false))
