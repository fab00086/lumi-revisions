$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$data = Join-Path $project 'data'
$backup = Join-Path $data ('backups\lumi-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null

$database = Join-Path $data 'lumi.sqlite'
if (Test-Path -LiteralPath $database) {
    $copy = Join-Path $backup 'lumi.sqlite'
    $env:LUMI_BACKUP_SOURCE = $database
    $env:LUMI_BACKUP_TARGET = $copy
    try {
        & node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.LUMI_BACKUP_SOURCE); db.exec('VACUUM INTO ' + String.fromCharCode(39) + process.env.LUMI_BACKUP_TARGET.replaceAll(String.fromCharCode(39), String.fromCharCode(39).repeat(2)) + String.fromCharCode(39)); db.close();"
        if ($LASTEXITCODE -ne 0) { throw 'Sauvegarde SQLite impossible.' }
    } finally {
        Remove-Item Env:LUMI_BACKUP_SOURCE,Env:LUMI_BACKUP_TARGET -ErrorAction SilentlyContinue
    }
}

@('lumi-data.json', 'cert.pem', 'key.pem') | ForEach-Object {
    $source = Join-Path $data $_
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $backup }
}
Copy-Item -LiteralPath (Join-Path $project '.env') -Destination $backup
Write-Output ('Sauvegarde terminée : ' + $backup)
