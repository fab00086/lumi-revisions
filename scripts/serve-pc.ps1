$ErrorActionPreference = 'Continue'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logs = Join-Path $project 'data\logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
Set-Location $project
$env:NO_OPEN_BROWSER = '1'

while ($true) {
    # Lumi peut aussi avoir été ouvert avec Lancer-Lumi.bat.
    # Dans ce cas, le serveur automatique attend sans ouvrir un second port HTTPS.
    $health = & curl.exe --silent --insecure --max-time 3 'https://127.0.0.1:3443/api/version' 2>$null
    if ($LASTEXITCODE -eq 0 -and $health -match '"version"') {
        Start-Sleep -Seconds 20
        continue
    }

    $log = Join-Path $logs ('serveur-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    ('[' + (Get-Date -Format o) + '] Démarrage de Lumi') | Out-File -FilePath $log -Append -Encoding utf8
    & node (Join-Path $project 'server.js') *>> $log
    ('[' + (Get-Date -Format o) + '] Lumi arrêté ; nouvelle tentative dans 10 secondes') | Out-File -FilePath $log -Append -Encoding utf8
    Start-Sleep -Seconds 10
}
