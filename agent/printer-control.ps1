<#
.SYNOPSIS
  Printer control host for agent.js. Long-running: reads one JSON request
  per line on stdin, acts on the Windows print spooler, and writes one JSON
  reply per line on stdout. Not meant to be run by hand.

.DESCRIPTION
  Request:  {"id":"c42","action":"cancel_job","printer":"HP M479","params":{"job_id":7,"document":"Report.pdf"}}
  Reply:    {"id":"c42","ok":true,"data":{...}}   or   {"id":"c42","ok":false,"error":"..."}

  Actions
    snapshot        every printer: status, error state, offline flag, queue, default settings
    cancel_job      remove one job from the queue
    pause_job       hold one job
    resume_job      release a held job
    restart_job     print a job again from the start
    pause_printer   hold the whole queue
    resume_printer  release the whole queue
    set_online      turn off "Use printer offline"
    test_page       print the Windows test page
    clear_queue     remove every job
    set_defaults    default sides / colour / paper size for new jobs
    capabilities    what one printer can do (driver print capabilities, paper, driver)

  Job actions name the job they expect (id + document name). The spooler
  reuses job ids, so a job that has changed since the request was made is
  left alone and the request fails with a clear message.

.PARAMETER Printers
  Optional comma-separated allowlist. Printers outside it are neither
  reported nor controlled.
#>

param(
  [string]$Printers = ""
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch {}
Import-Module PrintManagement -ErrorAction SilentlyContinue

$allow = @()
if ($Printers -ne "") { $allow = $Printers.Split(",") | ForEach-Object { $_.Trim() } }

function Test-Allowed([string]$name) {
  return ($allow.Count -eq 0) -or ($allow -contains $name)
}

function Get-WmiPrinter([string]$name) {
  # WQL string literals escape with backslash (\\server\printer names).
  $wql = $name.Replace('\', '\\').Replace("'", "\'")
  $p = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$wql'"
  if (-not $p) { throw "Printer '$name' was not found on this PC." }
  return $p
}

function Format-Time($t) {
  if ($t -is [DateTime]) { return $t.ToString("o") }
  return $null
}

function Assert-Method($result, [string]$what) {
  $code = [int]$result.ReturnValue
  if ($code -eq 5) { throw "Windows refused to $what (access denied). Run the agent as a user allowed to manage this printer." }
  if ($code -ne 0) { throw "Windows could not $what (error $code)." }
}

function Get-Snapshot {
  $ports = @{}
  try { foreach ($pt in @(Get-PrinterPort)) { $ports["$($pt.Name)"] = "$($pt.PrinterHostAddress)" } } catch {}
  $out = @()
  foreach ($p in @(Get-CimInstance -ClassName Win32_Printer)) {
    if (-not (Test-Allowed $p.Name)) { continue }
    $jobs = @()
    try {
      foreach ($j in @(Get-PrintJob -PrinterName $p.Name)) {
        $jobs += [ordered]@{
          id            = [int]$j.Id
          document      = "$($j.DocumentName)"
          owner         = "$($j.UserName)"
          status        = "$($j.JobStatus)"
          pages_printed = [int]$j.PagesPrinted
          total_pages   = [int]$j.TotalPages
          size          = [int64]$j.Size
          position      = [int]$j.Position
          submitted_at  = (Format-Time $j.SubmittedTime)
        }
      }
    } catch {}
    $config = $null
    try {
      $c = Get-PrintConfiguration -PrinterName $p.Name
      $config = [ordered]@{ duplex = "$($c.DuplexingMode)"; color = [bool]$c.Color; paper_size = "$($c.PaperSize)"; collate = [bool]$c.Collate }
    } catch {}
    $state = ""
    try { $state = "$((Get-Printer -Name $p.Name).PrinterStatus)" } catch {}
    $out += [ordered]@{
      name                 = "$($p.Name)"
      port                 = "$($p.PortName)"
      host                 = $ports["$($p.PortName)"]
      driver               = "$($p.DriverName)"
      is_default           = [bool]$p.Default
      work_offline         = [bool]$p.WorkOffline
      printer_status       = [int]$p.PrinterStatus
      detected_error_state = [int]$p.DetectedErrorState
      state                = $state
      jobs                 = $jobs
      config               = $config
    }
  }
  return ,$out
}

# What this printer can do: the driver's print capabilities (Print Schema),
# Windows' capability list and paper names, driver and sharing details.
function Get-Capabilities([string]$name) {
  $p = Get-WmiPrinter $name
  $driver = $null
  try { $driver = Get-PrinterDriver -Name $p.DriverName -ErrorAction Stop | Select-Object -First 1 } catch {}
  $driverVersion = ""
  if ($driver -and $driver.DriverVersion) {
    $v = [uint64]$driver.DriverVersion
    $driverVersion = "{0}.{1}.{2}.{3}" -f ($v -shr 48), (($v -shr 32) -band 0xFFFF), (($v -shr 16) -band 0xFFFF), ($v -band 0xFFFF)
  }
  $features = @()
  try {
    $pc = Get-PrintConfiguration -PrinterName $name
    [xml]$x = $pc.PrintCapabilitiesXML
    $ns = New-Object System.Xml.XmlNamespaceManager($x.NameTable)
    $ns.AddNamespace('psf', 'http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework')
    foreach ($f in $x.SelectNodes('/psf:PrintCapabilities/psf:Feature', $ns)) {
      $opts = @()
      foreach ($o in $f.SelectNodes('psf:Option', $ns)) {
        $odn = $o.SelectSingleNode("psf:Property[contains(@name,'DisplayName')]/psf:Value", $ns)
        $opts += [ordered]@{ name = "$($o.GetAttribute('name'))"; label = $(if ($odn) { "$($odn.InnerText)" } else { "" }) }
        if ($opts.Count -ge 40) { break }
      }
      $fdn = $f.SelectSingleNode("psf:Property[contains(@name,'DisplayName')]/psf:Value", $ns)
      $features += [ordered]@{ name = "$($f.GetAttribute('name'))"; label = $(if ($fdn) { "$($fdn.InnerText)" } else { "" }); options = $opts }
      if ($features.Count -ge 60) { break }
    }
  } catch {}
  $props = @()
  try {
    foreach ($pp in @(Get-PrinterProperty -PrinterName $name)) {
      $props += [ordered]@{ name = "$($pp.PropertyName)"; value = "$($pp.Value)" }
      if ($props.Count -ge 80) { break }
    }
  } catch {}
  return [ordered]@{
    capabilities = @($p.CapabilityDescriptions | ForEach-Object { "$_" })
    paper_names  = @($p.PrinterPaperNames | ForEach-Object { "$_" } | Select-Object -First 60)
    resolution   = [ordered]@{ x = [int]$p.HorizontalResolution; y = [int]$p.VerticalResolution }
    location     = "$($p.Location)"
    comment      = "$($p.Comment)"
    shared       = [bool]$p.Shared
    share_name   = "$($p.ShareName)"
    port         = "$($p.PortName)"
    network      = [bool]$p.Network
    driver       = [ordered]@{ name = "$($p.DriverName)"; manufacturer = $(if ($driver) { "$($driver.Manufacturer)" } else { "" }); version = $driverVersion }
    features     = $features
    properties   = $props
  }
}

function Find-Job([string]$printer, $params) {
  $id = [int]$params.job_id
  $job = Get-PrintJob -PrinterName $printer -ID $id -ErrorAction SilentlyContinue
  if (-not $job) { throw "That job has already finished or was removed." }
  if ($params.document -and "$($job.DocumentName)" -ne "$($params.document)") {
    throw "Job $id is now a different document ('$($job.DocumentName)'). Nothing was changed."
  }
  return $job
}

function Invoke-Action($req) {
  $printer = "$($req.printer)"
  $params = $req.params
  if ($req.action -ne 'snapshot') {
    if (-not $printer) { throw "No printer given." }
    if (-not (Test-Allowed $printer)) { throw "Printer '$printer' isn't monitored by this agent." }
  }
  switch ("$($req.action)") {
    'snapshot'       { return ,(Get-Snapshot) }
    'capabilities'   { return (Get-Capabilities $printer) }
    'cancel_job'     { Remove-PrintJob -InputObject (Find-Job $printer $params); return @{ done = $true } }
    'pause_job'      { Suspend-PrintJob -InputObject (Find-Job $printer $params); return @{ done = $true } }
    'resume_job'     { Resume-PrintJob -InputObject (Find-Job $printer $params); return @{ done = $true } }
    'restart_job'    { Restart-PrintJob -InputObject (Find-Job $printer $params); return @{ done = $true } }
    'pause_printer'  { Assert-Method (Invoke-CimMethod -InputObject (Get-WmiPrinter $printer) -MethodName Pause) 'pause the printer'; return @{ done = $true } }
    'resume_printer' { Assert-Method (Invoke-CimMethod -InputObject (Get-WmiPrinter $printer) -MethodName Resume) 'resume the printer'; return @{ done = $true } }
    'test_page'      { Assert-Method (Invoke-CimMethod -InputObject (Get-WmiPrinter $printer) -MethodName PrintTestPage) 'print a test page'; return @{ done = $true } }
    'set_online'     {
      Set-CimInstance -InputObject (Get-WmiPrinter $printer) -Property @{ WorkOffline = $false }
      return @{ done = $true }
    }
    'clear_queue'    {
      $jobs = @(Get-PrintJob -PrinterName $printer)
      foreach ($j in $jobs) { Remove-PrintJob -InputObject $j }
      return @{ removed = $jobs.Count }
    }
    'set_defaults'   {
      $settings = @{ PrinterName = $printer }
      if ($params.duplex) { $settings.DuplexingMode = "$($params.duplex)" }
      if ($null -ne $params.color) { $settings.Color = [bool]$params.color }
      if ($params.paper_size) { $settings.PaperSize = "$($params.paper_size)" }
      Set-PrintConfiguration @settings
      return @{ done = $true }
    }
    default          { throw "Unknown action '$($req.action)'." }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }   # agent.js closed stdin: exit
  if (-not $line.Trim()) { continue }
  $reply = [ordered]@{ id = $null; ok = $false }
  try {
    $req = $line | ConvertFrom-Json
    $reply.id = $req.id
    $reply.data = Invoke-Action $req
    $reply.ok = $true
  } catch {
    $reply.error = "$($_.Exception.Message)"
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
