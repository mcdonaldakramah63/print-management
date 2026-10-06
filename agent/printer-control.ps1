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
    devices         every printer traced to its device: network address (any port
                    type: TCP/IP, WSD, IPP, shared) or USB device, for counters
    usb_counter     a USB printer's page counter and status, asked in PJL

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
  # WSD, IPP and shared printers have no address on the port: use the device map.
  $deviceHosts = @{}
  try { foreach ($d in @(Get-Devices)) { if ($d.host) { $deviceHosts[$d.name] = $d.host } } } catch {}
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
      host                 = $(if ($ports["$($p.PortName)"]) { $ports["$($p.PortName)"] } else { $deviceHosts["$($p.Name)"] })
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

# ---------------------------------------------------------------
# Where each printer's own page counter can be read
#
# Photocopies (and toner levels) come from the device itself, so every
# Windows printer is traced back to the device behind it, whatever its port:
#   tcpip   Standard TCP/IP port: IP address or host name, SNMP community
#   wsd     WSD port (how Windows 10/11 adds network printers by itself):
#           the device's IP address from the port's URL or from Plug and Play
#   url     IPP / HTTP port (http://192.168.1.5:631/ipp/print)
#   shared  \\SERVER\Printer: the device behind the server's own port
#   usb     USB cable (USB001, DOT4_001): the USB device, read directly
#   virtual PDF, XPS, OneNote, fax: no device, left out
# ---------------------------------------------------------------
$UsbPrintGuid = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'   # GUID_DEVINTERFACE_USBPRINT
$script:DeviceCache = $null
$script:DeviceCacheAt = [DateTime]::MinValue

function Get-HostFromText([string]$s) {
  if (-not $s) { return $null }
  if ($s -match '(?i)^(?:https?|ipps?|socket|lpd)://\[?([^\]/:?#]+)') { return $Matches[1] }
  if ($s -match '(\d{1,3}(?:\.\d{1,3}){3})') { return $Matches[1] }
  return $null
}

# usbmon's ports: "USB001" -> the USB printer device behind it.
function Get-UsbPorts {
  $map = @{}
  $base = "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\$UsbPrintGuid"
  if (-not (Test-Path $base)) { return $map }
  foreach ($k in @(Get-ChildItem $base -ErrorAction SilentlyContinue)) {
    try {
      $p = Get-ItemProperty -Path (Join-Path $k.PSPath '#\Device Parameters') -ErrorAction Stop
      if ($null -eq $p.'Port Number') { continue }
      $baseName = if ($p.'Base Name') { "$($p.'Base Name')" } else { 'USB' }
      $port = '{0}{1:D3}' -f $baseName, [int]$p.'Port Number'
      $linked = 0
      try { $linked = [int](Get-ItemProperty -Path (Join-Path $k.PSPath '#\Control') -ErrorAction Stop).Linked } catch {}
      # A device that was unplugged keeps its entry: prefer the one present now.
      if ($map.ContainsKey($port) -and $map[$port].connected -and -not $linked) { continue }
      $map[$port] = @{ path = ($k.PSChildName -replace '^##\?#', '\\?\'); description = "$($p.'Port Description')"; connected = [bool]$linked }
    } catch {}
  }
  return $map
}

# WSD (PnP-X) devices know their IP address; tie them to print queues through
# the device container they share.
function Get-PnpHosts {
  $hosts = @{}
  if (-not (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue)) { return $hosts }
  $queues = @{}
  $ips = @{}
  try {
    $devs = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^(SWD\\PRINTENUM|SWD\\DAFWSDPROVIDER|SWD\\IPPENUM|UMB\\|WSDPRINT\\)' })
  } catch { return $hosts }
  foreach ($d in $devs) {
    try {
      $container = "$((Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_ContainerId' -ErrorAction Stop).Data)"
      if (-not $container) { continue }
      if ($d.InstanceId -like 'SWD\PRINTENUM*') { $queues["$($d.FriendlyName)"] = $container; continue }
      $found = $null
      foreach ($key in 'DEVPKEY_PNPX_IpAddress', 'DEVPKEY_Device_LocationInfo', 'DEVPKEY_PNPX_PresentationUrl') {
        try {
          $v = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName $key -ErrorAction Stop).Data
          foreach ($s in @($v)) { $h = Get-HostFromText "$s"; if ($h) { $found = $h; break } }
        } catch {}
        if ($found) { break }
      }
      if ($found -and -not $ips.ContainsKey($container)) { $ips[$container] = $found }
    } catch {}
  }
  foreach ($q in $queues.Keys) { if ($ips.ContainsKey($queues[$q])) { $hosts[$q] = $ips[$queues[$q]] } }
  return $hosts
}

function Get-Devices([bool]$fresh = $false) {
  if (-not $fresh -and $script:DeviceCache -and ((Get-Date) - $script:DeviceCacheAt).TotalMinutes -lt 10) { return ,$script:DeviceCache }
  $ports = @{}
  try { foreach ($pt in @(Get-PrinterPort)) { $ports["$($pt.Name)"] = $pt } } catch {}
  $tcp = @{}
  try { foreach ($pt in @(Get-CimInstance Win32_TCPIPPrinterPort)) { $tcp["$($pt.Name)"] = $pt } } catch {}
  $usb = Get-UsbPorts
  $pnp = $null
  $remote = @{}
  $out = @()
  foreach ($p in @(Get-CimInstance -ClassName Win32_Printer)) {
    if (-not (Test-Allowed $p.Name)) { continue }
    $port = "$($p.PortName)"
    $pt = $ports[$port]
    $d = [ordered]@{
      name = "$($p.Name)"; port = $port; kind = 'other'; host = $null; community = $null
      usb_path = $null; server = $null; note = $null
      color_capable = (@($p.Capabilities) -contains 2)
    }
    if ($port -match '^(?i)(nul:?|file:|portprompt:|xps.*|shrfax:|brfax:|onenote.*|.*\.pdf|microsoft\..*|ne\d\d:)$' -or "$($p.DriverName)" -match '(?i)(PDF|XPS|OneNote|\bFax\b)') {
      $d.kind = 'virtual'
    } elseif ($p.Network -and "$($p.ServerName)") {
      # \\SERVER\Share: find the device behind the server's own port.
      $d.kind = 'shared'
      $server = "$($p.ServerName)".TrimStart('\')
      $d.server = $server
      try {
        if (-not $remote.ContainsKey($server)) { $remote[$server] = @{ printers = @(Get-Printer -ComputerName $server -ErrorAction Stop); ports = @{} } }
        $rp = $remote[$server].printers | Where-Object { "$($_.ShareName)" -eq "$($p.ShareName)" -or "$($_.Name)" -eq "$($p.ShareName)" } | Select-Object -First 1
        if ($rp) {
          $rport = Get-PrinterPort -ComputerName $server -Name $rp.PortName -ErrorAction Stop
          $h = "$($rport.PrinterHostAddress)"
          if (-not $h) { $h = Get-HostFromText ("$($rport.DeviceURL) $($rp.PortName)") }
          if ($h) { $d.host = $h; $d.community = "$($rport.SNMPCommunity)" }
          elseif ("$($rp.PortName)" -match '^(?i)(USB|DOT4)') { $d.note = 'usb_on_server' }
        }
      } catch { $remote[$server] = @{ printers = @(); ports = @{} }; $d.note = 'server_unreachable' }
    } elseif ($usb.ContainsKey($port)) {
      $d.kind = 'usb'
      $d.usb_path = $usb[$port].path
      if (-not $usb[$port].connected) { $d.note = 'usb_unplugged' }
    } elseif ($port -match '^(?i)(USB|DOT4|TS)\d+') {
      $d.kind = 'usb'; $d.note = 'usb_device_not_found'
    } elseif ($port -match '^(?i)WSD') {
      $d.kind = 'wsd'
      if ($pt) { foreach ($prop in $pt.CimInstanceProperties) { if ($prop.Value -is [string]) { $h = Get-HostFromText $prop.Value; if ($h) { $d.host = $h; break } } } }
      if (-not $d.host) {
        if ($null -eq $pnp) { $pnp = Get-PnpHosts }
        if ($pnp.ContainsKey($d.name)) { $d.host = $pnp[$d.name] }
      }
    } elseif ($tcp.ContainsKey($port) -or ($pt -and "$($pt.PrinterHostAddress)")) {
      $d.kind = 'tcpip'
      $t = $tcp[$port]
      $d.host = if ($t -and "$($t.HostAddress)") { "$($t.HostAddress)" } else { "$($pt.PrinterHostAddress)" }
      if ($t -and $t.SNMPEnabled -and "$($t.SNMPCommunity)") { $d.community = "$($t.SNMPCommunity)" }
    } elseif ($port -match '^(?i)(https?|ipps?)://' -or ($pt -and "$($pt.Description)" -match '(?i)internet')) {
      $d.kind = 'url'
      $d.host = Get-HostFromText $port
    } elseif ($port -match '^(?i)(LPT|COM)\d') {
      $d.kind = 'parallel'
    } else {
      $d.host = Get-HostFromText $port
      if ($d.host) { $d.kind = 'tcpip' }
    }
    $out += $d
  }
  $script:DeviceCache = $out
  $script:DeviceCacheAt = Get-Date
  return ,$out
}

# ---------------------------------------------------------------
# A USB printer's page counter, asked over the cable in PJL
#
# Only printers whose IEEE 1284 device ID lists PJL among the languages
# they understand are asked: anything else could print the request as text.
# The device is opened for at most a few seconds, and only while nothing is
# waiting to print on it, so the spooler is never kept off the port.
# ---------------------------------------------------------------
$UsbPjlSource = @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class UsbPjl {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, int inSize, byte[] outBuf, int outSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CancelIoEx(SafeFileHandle h, IntPtr overlapped);

  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
  const uint SHARE_RW = 3, OPEN_EXISTING = 3, FILE_FLAG_OVERLAPPED = 0x40000000;
  const uint IOCTL_USBPRINT_GET_1284_ID = 0x220034;

  static SafeFileHandle Open(string path, uint flags) {
    SafeFileHandle h = CreateFile(path, GENERIC_READ | GENERIC_WRITE, SHARE_RW, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
    if (h.IsInvalid) {
      int err = Marshal.GetLastWin32Error();
      if (err == 32 || err == 5) throw new IOException("in use");
      if (err == 2 || err == 3) throw new IOException("not connected");
      throw new IOException("can't open the USB device (error " + err + ")");
    }
    return h;
  }

  public static string DeviceId(string path) {
    using (SafeFileHandle h = Open(path, 0)) {
      byte[] buf = new byte[1024];
      int n;
      if (!DeviceIoControl(h, IOCTL_USBPRINT_GET_1284_ID, IntPtr.Zero, 0, buf, buf.Length, out n, IntPtr.Zero) || n < 2) return "";
      int len = Math.Min((buf[0] << 8) | buf[1], n);
      return Encoding.ASCII.GetString(buf, 2, Math.Max(0, len - 2));
    }
  }

  public static string Ask(string path, string request, int timeoutMs) {
    using (SafeFileHandle h = Open(path, FILE_FLAG_OVERLAPPED))
    using (FileStream fs = new FileStream(h, FileAccess.ReadWrite, 4096, true)) {
      byte[] req = Encoding.ASCII.GetBytes(request);
      IAsyncResult w = fs.BeginWrite(req, 0, req.Length, null, null);
      if (!w.AsyncWaitHandle.WaitOne(timeoutMs)) { CancelIoEx(h, IntPtr.Zero); throw new IOException("the printer did not take the request"); }
      fs.EndWrite(w);
      StringBuilder sb = new StringBuilder();
      byte[] buf = new byte[4096];
      DateTime until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
      int feeds = 0;
      while (DateTime.UtcNow < until && feeds < 2) {
        IAsyncResult r = fs.BeginRead(buf, 0, buf.Length, null, null);
        int left = (int)Math.Max(1, (until - DateTime.UtcNow).TotalMilliseconds);
        if (!r.AsyncWaitHandle.WaitOne(left)) { CancelIoEx(h, IntPtr.Zero); try { fs.EndRead(r); } catch {} break; }
        int n = fs.EndRead(r);
        if (n == 0) { Thread.Sleep(100); continue; }
        string s = Encoding.ASCII.GetString(buf, 0, n);
        foreach (char c in s) if (c == '\f') feeds++;
        sb.Append(s);
      }
      return sb.ToString();
    }
  }
}
'@
$script:UsbPjlReady = $false

function Get-UsbCounter($params) {
  $path = "$($params.path)"
  if (-not $path.StartsWith('\\?\')) { throw "Not a USB printer device." }
  # Something waiting to print on this port: leave the device to the spooler.
  $port = "$($params.port)"
  if ($port) {
    $wql = $port.Replace('\', '\\').Replace("'", "\'")
    foreach ($q in @(Get-CimInstance -ClassName Win32_Printer -Filter "PortName='$wql'")) {
      $prefix = "$($q.Name), "
      if (@(Get-CimInstance -ClassName Win32_PrintJob | Where-Object { "$($_.Name)".StartsWith($prefix) }).Count -gt 0) { return @{ busy = $true } }
    }
  }
  if (-not $script:UsbPjlReady) { Add-Type -TypeDefinition $UsbPjlSource -Language CSharp; $script:UsbPjlReady = $true }
  $id = "$($params.device_id)"
  if (-not $id) { $id = [UsbPjl]::DeviceId($path) }
  if ($id -notmatch '(?i)(CMD|COMMAND SET):[^;]*\bPJL\b') { return @{ device_id = $id; pjl = $false } }
  $esc = [char]27
  $request = "$esc%-12345X@PJL`r`n@PJL INFO PAGECOUNT`r`n@PJL INFO STATUS`r`n$esc%-12345X"
  $reply = [UsbPjl]::Ask($path, $request, 3000)
  return @{ device_id = $id; pjl = $true; reply = $reply }
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
  if (@('snapshot', 'devices', 'usb_counter') -notcontains "$($req.action)") {
    if (-not $printer) { throw "No printer given." }
    if (-not (Test-Allowed $printer)) { throw "Printer '$printer' isn't monitored by this agent." }
  }
  switch ("$($req.action)") {
    'snapshot'       { return ,(Get-Snapshot) }
    'devices'        { return ,(Get-Devices ([bool]$params.fresh)) }
    'usb_counter'    { return (Get-UsbCounter $params) }
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
