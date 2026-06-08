# Smoke test for the Botswana Cadastral System.
# Checks the full stack: web proxy -> Express API -> Python engine (+ Groq AI).
# Run:  pwsh scripts/smoke-test.ps1
# Assumes servers are running (engine:8000, api:4000, web:3001).

$ErrorActionPreference = "Stop"
$api = "http://localhost:4000/api"
$pass = 0
$fail = 0

function Check($name, $cond, $detail) {
  if ($cond) { Write-Host "  [PASS] $name $detail" -ForegroundColor Green; $script:pass++ }
  else       { Write-Host "  [FAIL] $name $detail" -ForegroundColor Red;   $script:fail++ }
}

Write-Host "`n=== 1. Health check ===" -ForegroundColor Cyan
try {
  $h = Invoke-RestMethod "$api/health"
  Check "engine reachable" $h.engine ""
  Check "AI (Groq) configured" $h.ai ""
  Write-Host "  (db connected: $($h.db) — optional)" -ForegroundColor DarkGray
} catch { Check "API reachable" $false "-> is the API running on :4000?"; }

Write-Host "`n=== 2. CSV import + validation ===" -ForegroundColor Cyan
$csv = @"
Beacon ID,Easting,Northing,Bearing,Distance
B1,587432.14,7412088.32,45.12.30,124.56
B2,587556.70,7412176.44,92.04.15,88.20
B3,587644.91,7412174.12,181.55.42,102.30
B5,,,360.00.00,0.00
"@
$imp = Invoke-RestMethod "$api/import/text" -Method Post -ContentType "application/json" -Body (@{ text = $csv } | ConvertTo-Json)
Check "import parsed rows" ($imp.rows.Count -eq 4) "(got $($imp.rows.Count))"
Check "zero-distance row flagged as error" ($imp.errorCount -eq 1) "(errors=$($imp.errorCount))"

Write-Host "`n=== 3. COGO: perfect square must close exactly ===" -ForegroundColor Cyan
$square = @{
  start = @{ east = 0; north = 0; name = "A" }
  legs = @(
    @{ bearing = "90";  distance = 100 },
    @{ bearing = "180"; distance = 100 },
    @{ bearing = "270"; distance = 100 },
    @{ bearing = "0";   distance = 100 }
  )
  type = "closed"; adjustment = "bowditch"
} | ConvertTo-Json -Depth 5
$r = Invoke-RestMethod "$api/cogo/traverse" -Method Post -ContentType "application/json" -Body $square
Check "misclosure ~ 0" ([math]::Abs($r.closure.linear_misclosure) -lt 1e-6) "($($r.closure.linear_misclosure) m)"
Check "area = 1.0000 ha" ([math]::Abs($r.area_ha - 1.0) -lt 1e-4) "($($r.area_ha) ha)"

Write-Host "`n=== 4. COGO: 0.4m misclose -> Bowditch closes it ===" -ForegroundColor Cyan
$bad = @{
  start = @{ east = 0; north = 0; name = "A" }
  legs = @(
    @{ bearing = "90";  distance = 100 },
    @{ bearing = "180"; distance = 100 },
    @{ bearing = "270"; distance = 100 },
    @{ bearing = "0";   distance = 100.4 }
  )
  type = "closed"; adjustment = "bowditch"
} | ConvertTo-Json -Depth 5
$r2 = Invoke-RestMethod "$api/cogo/traverse" -Method Post -ContentType "application/json" -Body $bad
$sumE = ($r2.legs | Measure-Object d_east_adj -Sum).Sum
$sumN = ($r2.legs | Measure-Object d_north_adj -Sum).Sum
Check "raw misclosure = 0.4m" ([math]::Abs($r2.closure.linear_misclosure - 0.4) -lt 1e-4) "($($r2.closure.linear_misclosure) m)"
Check "adjusted traverse closes" (([math]::Abs($sumE) -lt 1e-6) -and ([math]::Abs($sumN) -lt 1e-6)) "(dE=$sumE dN=$sumN)"

Write-Host "`n=== 5. Inverse (join) round-trip ===" -ForegroundColor Cyan
$inv = Invoke-RestMethod "$api/cogo/inverse" -Method Post -ContentType "application/json" -Body (@{
  from_point = @{ east = 0; north = 0 }; to_point = @{ east = 100; north = 0 }
} | ConvertTo-Json)
Check "due-east bearing = 90" ([math]::Abs($inv.bearing - 90) -lt 1e-6) "($($inv.bearing) deg)"
Check "distance = 100m" ([math]::Abs($inv.distance - 100) -lt 1e-6) "($($inv.distance) m)"

Write-Host "`n=== 6. AI validation (Groq) ===" -ForegroundColor Cyan
$val = Invoke-RestMethod "$api/validate" -Method Post -ContentType "application/json" -Body (@{
  closure = @{ relative_precision = 4820; relative_precision_text = "1:4,820"; linear_misclosure = 0.042 }
  dsmLimit = 3000
  beaconNames = @("B1","B2","B3","B4")
  importRows = @(@{ status = "error"; issues = @("zero distance"); beaconId = "B5" })
  project = @{ name = "Smoke Test Survey"; surveyor = "Test"; crs = "Lo 21" }
} | ConvertTo-Json -Depth 5)
Check "validation produced checks" ($val.checks.Count -gt 0) "($($val.checks.Count) checks, score $($val.overallScore)%)"
Check "AI narrative generated" ($val.narrative.Length -gt 20) "(source: $($val.aiSource))"

Write-Host "`n=== 7. Module B: coordinate transforms ===" -ForegroundColor Cyan
$crsList = Invoke-RestMethod "$api/crs/list"
Check "8 coordinate systems available" ($crsList.systems.Count -eq 8) "(got $($crsList.systems.Count))"
$tr = Invoke-RestMethod "$api/crs/transform" -Method Post -ContentType "application/json" -Body (@{
  src = "Lo21"; dst = "WGS84"; points = @(@{ a = 93205.88; b = 2464520.65; name = "A" })
} | ConvertTo-Json -Depth 5)
$lat = $tr.points[0].a; $lon = $tr.points[0].b
Check "Lo21->WGS84 gives Botswana lat/lon" (($lat -lt -15) -and ($lat -gt -30) -and ($lon -gt 18) -and ($lon -lt 30)) "(lat=$lat lon=$lon)"
# Round-trip: WGS84 back to Lo21 returns original plane coords
$back = Invoke-RestMethod "$api/crs/transform" -Method Post -ContentType "application/json" -Body (@{
  src = "WGS84"; dst = "Lo21"; points = @(@{ a = $lat; b = $lon })
} | ConvertTo-Json -Depth 5)
$dy = [math]::Abs($back.points[0].a - 93205.88); $dx = [math]::Abs($back.points[0].b - 2464520.65)
Check "Lo21->WGS84->Lo21 round-trips (<0.01m)" (($dy -lt 0.01) -and ($dx -lt 0.01)) "(dY=$([math]::Round($dy,4)) dX=$([math]::Round($dx,4)))"

Write-Host "`n=== 8. Least Squares adjustment ===" -ForegroundColor Cyan
$lsq = Invoke-RestMethod "$api/cogo/traverse" -Method Post -ContentType "application/json" -Body (@{
  start = @{ east = 0; north = 0; name = "A" }
  legs = @(
    @{ bearing = "90"; distance = 100 }, @{ bearing = "180"; distance = 100 },
    @{ bearing = "270"; distance = 100 }, @{ bearing = "0"; distance = 100.4 }
  )
  type = "closed"; adjustment = "lsq"
} | ConvertTo-Json -Depth 5)
$lse = ($lsq.legs | Measure-Object d_east_adj -Sum).Sum
$lsn = ($lsq.legs | Measure-Object d_north_adj -Sum).Sum
Check "LSQ method applied" ($lsq.adjustment -eq "lsq") ""
Check "LSQ closes the traverse" (([math]::Abs($lse) -lt 1e-5) -and ([math]::Abs($lsn) -lt 1e-5)) "(dE=$lse dN=$lsn)"

Write-Host "`n========================================" -ForegroundColor Cyan
if ($fail -eq 0) { Write-Host "ALL $pass CHECKS PASSED" -ForegroundColor Green }
else { Write-Host "$pass passed, $fail FAILED" -ForegroundColor Red }
Write-Host "========================================`n"
