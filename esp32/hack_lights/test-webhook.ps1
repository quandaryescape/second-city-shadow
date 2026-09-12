# Fires the hack webhook at the ESP32 the same way app/server.js does.
#
#   .\test-webhook.ps1                      # sends 101010
#   .\test-webhook.ps1 -Bits 101001         # sends one pattern
#   .\test-webhook.ps1 -Sweep               # walks all 64 patterns, 2s apart
#   .\test-webhook.ps1 -HostAddr 192.168.1.77   # different board address

param(
  [string]$HostAddr = "192.168.1.50",
  [string]$Bits     = "101010",
  [switch]$Sweep,
  [int]$DelayMs     = 2000
)

$url = "http://$HostAddr/trigger/hack"

function Send-Pattern([string]$b) {
  # same shape server.js builds in lightPatternPayload()
  $lights = @()
  foreach ($c in $b.ToCharArray()) { $lights += [int]::Parse($c) }
  $mask = 0
  for ($i = 0; $i -lt $lights.Count; $i++) { if ($lights[$i]) { $mask = $mask -bor (1 -shl $i) } }

  $top    = @($lights[0], $lights[1], $lights[2])
  $bottom = @($lights[3], $lights[4], $lights[5])

  $body = [ordered]@{
    event   = "hack_complete"
    room    = "TEST"
    pattern = (, $top + , $bottom)
    lights  = $lights
    bits    = $b
    mask    = $mask
    rows    = 2
    cols    = 3
  } | ConvertTo-Json -Compress -Depth 5

  Write-Host "-> $b (mask $mask)" -NoNewline
  try {
    $res = Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body $body -TimeoutSec 5
    Write-Host "  OK  $($res | ConvertTo-Json -Compress)" -ForegroundColor Green
  } catch {
    Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
  }
}

if ($Sweep) {
  Write-Host "Sweeping all 64 patterns at $url`n"
  for ($m = 0; $m -lt 64; $m++) {
    $b = ""
    for ($i = 0; $i -lt 6; $i++) { $b += [string](($m -shr $i) -band 1) }
    Send-Pattern $b
    Start-Sleep -Milliseconds $DelayMs
  }
} else {
  if ($Bits.Length -ne 6) { Write-Host "Bits must be 6 characters, e.g. 101001" -ForegroundColor Yellow; exit 1 }
  Send-Pattern $Bits
}
