<#
.SYNOPSIS
  Watches the Windows print spooler and emits one JSON object per finished
  print job on stdout. Run as a child process by agent.js — not meant to be
  run standalone in production, though it's safe to try.

.DESCRIPTION
  Two WMI event subscriptions on Win32_PrintJob:

  * Creation — as soon as a job appears in the queue, the job's own print
    settings are read from the spooler (GetJob, level 2 -> its DEVMODE):
    copies, colour/mono, duplex, collation, paper size, and the client
    machine that submitted it. These are the settings THIS job was sent
    with, not the printer's defaults. Cached until the job finishes.

  * Deletion — a job leaves the queue once it finishes printing (or is
    cancelled). That's when it is reported: the page count is final and the
    print actually happened. The cached settings are merged in.

  Only job METADATA is read from the spooler: document name, page count,
  size, settings, the Windows user and machine that submitted it, printer,
  timestamps. The document's contents are never read from the spooler.

  -InspectDocuments (opt-in, off by default): additionally tries to find the
  source file of each job on THIS PC (the submitting user's Recent items,
  Downloads/Desktop/Documents, and the root of removable drives) and passes
  its local path to agent.js, which reads only the page count from it
  (PDF page tree, Word/PowerPoint document properties). The path and file
  never leave this PC.

.PARAMETER Printers
  Optional comma-separated allowlist of printer names. If omitted, jobs
  from every printer on this machine are reported.

.PARAMETER InspectDocuments
  Look up each job's source document so its full page count can be measured.
#>

param(
  [string]$Printers = "",
  [switch]$InspectDocuments
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$printerFilter = @()
if ($Printers -ne "") {
  $printerFilter = $Printers.Split(",") | ForEach-Object { $_.Trim() }
}

# ---------------------------------------------------------------
# Per-job settings straight from the spooler (winspool GetJob level 2).
# ---------------------------------------------------------------
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class SpoolerJob
{
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetJob(IntPtr hPrinter, int jobId, int level, IntPtr pJob, int cbBuf, out int pcbNeeded);

    [StructLayout(LayoutKind.Sequential)]
    private struct SYSTEMTIME
    {
        public short Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOB_INFO_2
    {
        public int JobId;
        public IntPtr pPrinterName, pMachineName, pUserName, pDocument, pNotifyName, pDatatype,
                      pPrintProcessor, pParameters, pDriverName, pDevMode, pStatus, pSecurityDescriptor;
        public int Status, Priority, Position, StartTime, UntilTime, TotalPages, Size;
        public SYSTEMTIME Submitted;
        public int Time, PagesPrinted;
    }

    public class Settings
    {
        public int Copies = -1;
        public int Color = -1;       // 1 = monochrome, 2 = colour
        public int Duplex = -1;      // 1 = simplex, 2/3 = duplex
        public int Collate = -1;     // 0 = off, 1 = on
        public int PaperSize = -1;   // DMPAPER_* code (9 = A4, 8 = A3, 1 = Letter)
        public int TotalPages = -1;
        public string MachineName = "";
    }

    // DEVMODEW byte offsets (fixed public layout from wingdi.h).
    private const int OFF_FIELDS = 72, OFF_PAPERSIZE = 78, OFF_COPIES = 86,
                      OFF_COLOR = 92, OFF_DUPLEX = 94, OFF_COLLATE = 100;
    private const int DM_PAPERSIZE = 0x2, DM_COPIES = 0x100, DM_COLOR = 0x800,
                      DM_DUPLEX = 0x1000, DM_COLLATE = 0x8000;

    public static Settings Read(string printerName, int jobId)
    {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return null;
        try
        {
            int needed;
            GetJob(hPrinter, jobId, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0) return null;
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetJob(hPrinter, jobId, 2, buffer, needed, out needed)) return null;
                JOB_INFO_2 info = (JOB_INFO_2)Marshal.PtrToStructure(buffer, typeof(JOB_INFO_2));
                Settings s = new Settings();
                s.TotalPages = info.TotalPages;
                if (info.pMachineName != IntPtr.Zero) s.MachineName = Marshal.PtrToStringUni(info.pMachineName);
                IntPtr dm = info.pDevMode;
                if (dm != IntPtr.Zero)
                {
                    int fields = Marshal.ReadInt32(dm, OFF_FIELDS);
                    if ((fields & DM_COPIES) != 0) s.Copies = Marshal.ReadInt16(dm, OFF_COPIES);
                    if ((fields & DM_COLOR) != 0) s.Color = Marshal.ReadInt16(dm, OFF_COLOR);
                    if ((fields & DM_DUPLEX) != 0) s.Duplex = Marshal.ReadInt16(dm, OFF_DUPLEX);
                    if ((fields & DM_COLLATE) != 0) s.Collate = Marshal.ReadInt16(dm, OFF_COLLATE);
                    if ((fields & DM_PAPERSIZE) != 0) s.PaperSize = Marshal.ReadInt16(dm, OFF_PAPERSIZE);
                }
                return s;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { ClosePrinter(hPrinter); }
    }
}
"@

# ---------------------------------------------------------------
# Optional: find a job's source document on this PC (path stays local).
# ---------------------------------------------------------------
$shell = $null
function Find-SourceDocument([string]$docName, [string]$owner) {
  if (-not $docName) { return $null }
  $name = ($docName.Trim() -replace '^Microsoft [A-Za-z ]+? - ', '')
  try {
    if ([System.IO.Path]::IsPathRooted($name) -and (Test-Path -LiteralPath $name -PathType Leaf)) { return $name }
    $leaf = [System.IO.Path]::GetFileName($name)
  } catch { return $null }
  if (-not $leaf) { return $null }
  $leafNoExt = [System.IO.Path]::GetFileNameWithoutExtension($leaf)
  $hasExt = [System.IO.Path]::HasExtension($leaf)

  $isSameFile = {
    param($fileName)
    if ($hasExt) { return $fileName -ieq $leaf }
    return [System.IO.Path]::GetFileNameWithoutExtension($fileName) -ieq $leafNoExt
  }

  $user = ($owner -split '\\')[-1]
  $profileDir = Join-Path $env:SystemDrive "Users\$user"

  # 1. The user's Recent items: a shortcut per file they opened lately.
  $recent = Join-Path $profileDir 'AppData\Roaming\Microsoft\Windows\Recent'
  if (Test-Path -LiteralPath $recent) {
    if (-not $script:shell) { $script:shell = New-Object -ComObject WScript.Shell }
    $links = Get-ChildItem -LiteralPath $recent -Filter '*.lnk' -File -ErrorAction SilentlyContinue |
      Where-Object { & $isSameFile $_.BaseName } | Sort-Object LastWriteTime -Descending | Select-Object -First 3
    foreach ($link in $links) {
      $target = $script:shell.CreateShortcut($link.FullName).TargetPath
      if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) { return $target }
    }
  }

  # 2. Common folders, then the root of USB drives (customers' flash drives).
  $folders = @('Downloads', 'Desktop', 'Documents') | ForEach-Object { Join-Path $profileDir $_ }
  try {
    $folders += Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.DeviceID)\" }
  } catch {}
  foreach ($folder in $folders) {
    if (-not (Test-Path -LiteralPath $folder)) { continue }
    $hit = Get-ChildItem -LiteralPath $folder -File -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { & $isSameFile $_.Name } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

Write-Host "[watch-print-jobs] Subscribing to print job events..."
if ($printerFilter.Count -gt 0) {
  Write-Host "[watch-print-jobs] Filtering to printers: $($printerFilter -join ', ')"
}
if ($InspectDocuments) {
  Write-Host "[watch-print-jobs] Source document page counting is ON."
}

$startId = "ReceiptSystemPrintStart"
$doneId = "ReceiptSystemPrintWatch"
$startQuery = "SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_PrintJob'"
$doneQuery = "SELECT * FROM __InstanceDeletionEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_PrintJob'"

# Clean up any stale subscriptions from a previous crashed run before registering.
foreach ($id in @($startId, $doneId)) {
  Get-EventSubscriber -SourceIdentifier $id -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue
}

try {
  Register-CimIndicationEvent -Query $startQuery -SourceIdentifier $startId | Out-Null
  Register-CimIndicationEvent -Query $doneQuery -SourceIdentifier $doneId | Out-Null
} catch {
  Write-Error "Failed to subscribe to Win32_PrintJob events. Is the Print Spooler service running? $_"
  exit 1
}

# key "printer|jobId" -> @{ Settings; SeenAt }
$jobCache = @{}

function Get-JobKey($job) {
  $nameParts = $job.Name -split ","
  return @{ Printer = $nameParts[0].Trim(); JobId = [int]$job.JobId }
}

function Convert-JobTime($value) {
  if (-not $value) { return $null }
  # CIM hands back a DateTime; older WMI cmdlets return a DMTF string.
  if ($value -is [DateTime]) { return $value.ToLocalTime().ToString("o") }
  return [System.Management.ManagementDateTimeConverter]::ToDateTime($value).ToString("o")
}

try {
  while ($true) {
    $evt = Wait-Event
    # Remove only THIS event; removing by source would drop others that
    # arrived in the same polling window.
    Remove-Event -EventIdentifier $evt.EventIdentifier

    try {
      $job = $evt.SourceEventArgs.NewEvent.TargetInstance
      $id = Get-JobKey $job
      $key = "$($id.Printer)|$($id.JobId)"

      if ($printerFilter.Count -gt 0 -and ($printerFilter -notcontains $id.Printer)) { continue }

      if ($evt.SourceIdentifier -eq $startId) {
        $settings = $null
        try { $settings = [SpoolerJob]::Read($id.Printer, $id.JobId) } catch {}
        $jobCache[$key] = @{ Settings = $settings; SeenAt = (Get-Date) }
        # Forget jobs that never finished (deleted while we weren't looking).
        foreach ($stale in @($jobCache.Keys | Where-Object { $jobCache[$_].SeenAt -lt (Get-Date).AddHours(-12) })) {
          $jobCache.Remove($stale)
        }
        continue
      }

      if ($evt.SourceIdentifier -ne $doneId) { continue }

      $cached = $jobCache[$key]
      $jobCache.Remove($key)
      $settings = if ($cached) { $cached.Settings } else { $null }

      $submittedAt = (Get-Date).ToString("o")
      try {
        $t = Convert-JobTime $job.TimeSubmitted
        if ($t) { $submittedAt = $t }
      } catch {}

      # Pages per copy: PagesPrinted (what came out) if set, else TotalPages
      # (what was requested), else the spooler's own count from creation time.
      $pages = 0
      if ($job.PagesPrinted -and [int]$job.PagesPrinted -gt 0) {
        $pages = [int]$job.PagesPrinted
      } elseif ($job.TotalPages -and [int]$job.TotalPages -gt 0) {
        $pages = [int]$job.TotalPages
      } elseif ($settings -and $settings.TotalPages -gt 0) {
        $pages = $settings.TotalPages
      }

      # Colour: the job's own DEVMODE first, then Win32_PrintJob.Color, which
      # is a STRING ("Color" / "Monochrome") — never compare it as a boolean.
      $colorMode = "unknown"
      if ($settings -and $settings.Color -eq 2) { $colorMode = "color" }
      elseif ($settings -and $settings.Color -eq 1) { $colorMode = "mono" }
      elseif ($job.Color -eq "Color") { $colorMode = "color" }
      elseif ($job.Color -eq "Monochrome") { $colorMode = "mono" }

      # Duplex: the job's own DEVMODE first; only if that wasn't captured,
      # fall back to the printer's current default (a weaker signal).
      $duplexMode = "unknown"
      if ($settings -and $settings.Duplex -eq 1) { $duplexMode = "simplex" }
      elseif ($settings -and $settings.Duplex -ge 2) { $duplexMode = "duplex" }
      else {
        try {
          # WQL string literals escape with backslash: double backslashes
          # (network printers are named like \\server\printer) and quotes.
          $wqlName = $id.Printer.Replace('\', '\\').Replace("'", "\'")
          $printerConfig = Get-CimInstance -ClassName Win32_PrinterConfiguration -Filter "Name='$wqlName'" -ErrorAction Stop
          if ($printerConfig -and ($null -ne $printerConfig.Duplex)) {
            $duplexMode = if ($printerConfig.Duplex) { "duplex" } else { "simplex" }
          }
        } catch {}
      }

      # Client PC: HostPrintQueue is "\\MACHINE" for the computer that sent the job.
      $clientMachine = ""
      if ($job.HostPrintQueue) { $clientMachine = "$($job.HostPrintQueue)" }
      elseif ($settings -and $settings.MachineName) { $clientMachine = $settings.MachineName }

      $payload = [ordered]@{
        printer_name    = $id.Printer
        external_job_id = "$($id.JobId)"
        document_name   = $job.Document
        submitted_by    = $job.Owner
        client_machine  = $clientMachine
        pages           = $pages
        size_bytes      = [int64]($job.Size)
        color_mode      = $colorMode
        duplex          = $duplexMode
        submitted_at    = $submittedAt
        completed_at    = (Get-Date).ToString("o")
      }
      if ($settings) {
        $payload.settings_source = "devmode"
        if ($settings.Copies -gt 0) { $payload.copies = [int]$settings.Copies }
        if ($settings.Collate -ge 0) { $payload.collate = ($settings.Collate -eq 1) }
        if ($settings.PaperSize -gt 0) { $payload.paper_size = [int]$settings.PaperSize }
      }
      if ($InspectDocuments) {
        try {
          $sourcePath = Find-SourceDocument "$($job.Document)" "$($job.Owner)"
          if ($sourcePath) { $payload.source_path = $sourcePath }  # local only; agent.js strips it
        } catch {}
      }

      Write-Output ([PSCustomObject]$payload | ConvertTo-Json -Compress)
      [Console]::Out.Flush()
    } catch {
      Write-Host "[watch-print-jobs] Error handling event: $_"
    }
  }
} finally {
  foreach ($id in @($startId, $doneId)) {
    Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue
  }
}
