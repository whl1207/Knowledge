param([string[]]$Paths, [string]$Out = "$env:TEMP\dt", [switch]$Quiet)
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$hdr = @{ 'User-Agent' = 'Mozilla/5.0 research' }
$enc = New-Object System.Text.UTF8Encoding($false)
$res = @()
foreach ($p in $Paths) {
  $safe = ($p -replace '[\\/:*?"<>|]', '__')
  $dest = Join-Path $Out $safe
  if (Test-Path $dest) { $res += "SKIP $p"; continue }
  $url = "https://raw.githubusercontent.com/HKUDS/DeepTutor/main/$p"
  try {
    $resp = Invoke-WebRequest -Uri $url -Headers $hdr -TimeoutSec 60 -UseBasicParsing
    [System.IO.File]::WriteAllText($dest, $resp.Content, $enc)
    $res += ("OK {0} {1}" -f $p, $resp.RawContentLength)
  } catch {
    $res += ("FAIL {0}" -f $p)
  }
  Start-Sleep -Milliseconds 60
}
if ($Quiet) { $res | Where-Object { $_ -like 'FAIL*' } } else { $res }
