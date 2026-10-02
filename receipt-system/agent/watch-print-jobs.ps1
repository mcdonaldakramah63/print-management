<#
.SYNOPSIS
  Watches the Windows print spooler for completed print jobs and emits one
  JSON object per line to stdout. Run as a child process by agent.js — not
  meant to be run standalone in production, though it's safe to try.

.DESCRIPTION
  Subscribes to WMI __InstanceDeletionEvent notifications for Win32_PrintJob.
  A job is deleted from the spooler's job list once it finishes printing (or
  is cancelled), which is the right moment to report it for billing: the
  page count is final at that point, and it confirms the print actually
  completed rather than just being requested.

  Only job METADATA is read here: document name, page count, size, color
  mode, the Windows username that submitted it, the printer, and the
  timestamp. The document's actual contents are never touched.

  Color/mono detection uses Win32_PrintJob's "Color" property, which
  reflects the print driver's color-vs-grayscale setting (DEVMODE.dmColor).
  This is generally reliable for standard drivers since it's a first-class
  Windows printing setting, but isn't guaranteed for every printer/driver —
  verify against your actual printer. When it can't be determined, the job
  is reported with color_mode "unknown" and the backend will require a
  human to pick the product manually rather than guess.

.PARAMETER Printers
  Optional comma-separated allowlist of printer names. If omitted, jobs
  from every printer on this machine are reported.
#>

param(
  [string]$Printers = ""
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$printerFilter = @()
if ($Printers -ne "") {
  $printerFilter = $Printers.Split(",") | ForEach-Object { $_.Trim() }
}

Write-Host "[watch-print-jobs] Subscribing to print job completion events..."
if ($printerFilter.Count -gt 0) {
  Write-Host "[watch-print-jobs] Filtering to printers: $($printerFilter -join ', ')"
}

$sourceId = "ReceiptSystemPrintWatch"
$query = "SELECT * FROM __InstanceDeletionEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_PrintJob'"

# Clean up any stale subscription from a previous crashed run before registering.
Get-EventSubscriber -SourceIdentifier $sourceId -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue

try {
  Register-CimIndicationEvent -Query $query -SourceIdentifier $sourceId | Out-Null
} catch {
  Write-Error "Failed to subscribe to Win32_PrintJob events. Is the Print Spooler service running? $_"
  exit 1
}

try {
  while ($true) {
    $evt = Wait-Event -SourceIdentifier $sourceId
    Remove-Event -SourceIdentifier $sourceId

    try {
      $job = $evt.SourceEventArgs.NewEvent.TargetInstance

      # Win32_PrintJob.Name is normally "PrinterName,JobId"
      $nameParts = $job.Name -split ","
      $printerName = $nameParts[0].Trim()
      $jobId = $job.JobId

      if ($printerFilter.Count -gt 0 -and ($printerFilter -notcontains $printerName)) {
        continue
      }

      $submittedAt = (Get-Date).ToString("o")
      if ($job.TimeSubmitted) {
        try {
          $submittedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime($job.TimeSubmitted).ToString("o")
        } catch {
          # Fall back to "now" if the CIM datetime can't be parsed
        }
      }

      # Prefer PagesPrinted (what actually came out of the printer) and fall
      # back to TotalPages (what was requested) if PagesPrinted wasn't set.
      $pages = 0
      if ($job.PagesPrinted -and [int]$job.PagesPrinted -gt 0) {
        $pages = [int]$job.PagesPrinted
      } elseif ($job.TotalPages -and [int]$job.TotalPages -gt 0) {
        $pages = [int]$job.TotalPages
      }

      $colorMode = "unknown"
      if ($null -ne $job.Color) {
        $colorMode = if ($job.Color) { "color" } else { "mono" }
      }

      $payload = [PSCustomObject]@{
        printer_name    = $printerName
        external_job_id = "$jobId"
        document_name   = $job.Document
        submitted_by    = $job.Owner
        pages           = $pages
        size_bytes      = [int64]($job.Size)
        color_mode      = $colorMode
        submitted_at    = $submittedAt
      }

      $json = $payload | ConvertTo-Json -Compress
      Write-Output $json
      [Console]::Out.Flush()
    } catch {
      Write-Host "[watch-print-jobs] Error handling event: $_"
    }
  }
} finally {
  Unregister-Event -SourceIdentifier $sourceId -ErrorAction SilentlyContinue
}
