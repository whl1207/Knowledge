param([string[]]$Paths, [string]$Out = "$env:TEMP\dt")
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$hdr = @{ 'User-Agent' = 'dsh-research'; 'Accept' = 'application/vnd.github+json' }
foreach ($p in $Paths) {
  $safe = ($p -replace '[\\/:*?"<>|]', '__')
  $dest = Join-Path $Out $safe
  if (Test-Path $dest) { Write-Output "SKIP $p"; continue }
  $url = "https://api.github.com/repos/HKUDS/DeepTutor/contents/$p"
  try {
    $r = Invoke-RestMethod -Uri $url -Headers $hdr -TimeoutSec 60
    if ($r.content) {
      $bytes = [Convert]::FromBase64String(($r.content -replace '\s', ''))
      [System.IO.File]::WriteAllBytes($dest, $bytes)
      Write-Output ("OK {0} {1} bytes" -f $p, $bytes.Length)
    } else { Write-Output "NOBLOCK $p (dir or empty)" }
  } catch {
    Write-Output ("FAIL {0} :: {1}" -f $p, $_.Exception.Message)
  }
  Start-Sleep -Milliseconds 120
}
