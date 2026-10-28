# Liste toutes les apps installées, comme le menu Démarrer : raccourcis (.lnk, .url) des
# dossiers « Programmes » + apps du Store et autres apps connues de Windows.
# Écrit sur stdout un tableau JSON trié par nom : [{ name, open, iconFile }]

. (Join-Path $PSScriptRoot 'common.ps1')

# Raccourcis qui ne sont pas des apps : désinstalleurs, docs, sites web...
$notAnAppPattern = "$installerPattern|d.sinstall|readme|lisez|website|site web|documentation|manual|manuel|help|aide|release notes|licen[cs]e|support center"

$apps = [ordered]@{}
function Add-App([string]$name, [string]$open, [string]$iconFile) {
    $id = Normalize $name
    if (-not $id -or $apps.Contains($id)) { return }
    if ($excludedNames -contains $name -or $name -match $notAnAppPattern) { return }
    $apps[$id] = [pscustomobject]@{ name = $name; open = $open; iconFile = $iconFile }
}

# 1. Raccourcis du menu Démarrer (utilisateur puis commun) : on les préfère, ils ont une icône.
$folders = 'StartMenu', 'CommonStartMenu' | ForEach-Object {
    Join-Path ([Environment]::GetFolderPath($_)) 'Programs'
}
$systemFolders = '\\(Administrative Tools|Windows Tools|System Tools|Accessibility|Maintenance|Windows Kits|Outils d.administration|Outils Windows|Outils syst.me|Accessibilit.)\\'
Get-ChildItem -LiteralPath $folders -Recurse -File -Include *.lnk, *.url |
    Where-Object { $_.FullName -notmatch $systemFolders } | ForEach-Object {
    $name = $_.BaseName -replace ' - (Raccourci|Shortcut)$', ''
    $iconFile = $null
    if ($_.Extension -eq '.url') {
        # Les jeux Steam sont des .url : leur icône est indiquée dans le fichier.
        $line = Select-String -LiteralPath $_.FullName -Pattern '^IconFile=(.+)$' | Select-Object -First 1
        if ($line) {
            $candidate = $line.Matches[0].Groups[1].Value.Trim()
            if (Test-Path -LiteralPath $candidate) { $iconFile = $candidate }
        }
    }
    Add-App $name $_.FullName $iconFile
}

# 2. Le reste de ce que Windows connaît (apps du Store surtout).
Get-StartApps | ForEach-Object {
    $id = $_.AppID
    if ($excludedIds | Where-Object { $id.StartsWith($_, 'OrdinalIgnoreCase') }) { return }
    if ($id -match '^[a-z]+://') {
        Add-App $_.Name $id $null
    } elseif ($id -match '^\{[0-9A-Fa-f-]{36}\}\\') {
        $path = Resolve-KnownFolder $id
        if ($path -and (Test-Path -LiteralPath $path)) { Add-App $_.Name $path $null }
    } else {
        Add-App $_.Name "shell:AppsFolder\$id" (Get-PackageIcon $id)
    }
}

$result = $apps.Values | Sort-Object name
ConvertTo-Json -InputObject @($result) -Compress
