# Liste les apps les plus lancées récemment, d'après le registre UserAssist de Windows
# (ce qui alimente « Plus utilisées » du menu Démarrer : lancements depuis le menu,
# la barre des tâches ou le bureau).
# Écrit sur stdout un tableau JSON trié : [{ name, open, runs, focusMinutes, lastUsed, iconFile }]

param(
    [int]$Days = 30,
    [int]$Max = 40
)

. (Join-Path $PSScriptRoot 'common.ps1')

$genericExeNames = @('game', 'launcher', 'start', 'play', 'main', 'nw', 'nwjs', 'electron', 'unity')

function Rot13([string]$text) {
    -join ($text.ToCharArray() | ForEach-Object {
        $c = [int]$_
        if ($c -ge 65 -and $c -le 90) { [char](65 + ($c - 65 + 13) % 26) }
        elseif ($c -ge 97 -and $c -le 122) { [char](97 + ($c - 97 + 13) % 26) }
        else { $_ }
    })
}

function Get-ExeName([string]$path) {
    $info = (Get-Item -LiteralPath $path).VersionInfo
    $name = @($info.ProductName, $info.FileDescription) | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1
    if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($path) }
    # "Game.exe" ou "Launcher.exe" ne disent rien : on prend le nom du dossier.
    if ($genericExeNames -contains $name.Trim().ToLowerInvariant()) {
        $name = Split-Path (Split-Path $path -Parent) -Leaf
    }
    return $name.Trim()
}

$startApps = @{}
Get-StartApps | ForEach-Object { $startApps[$_.AppID] = $_.Name }
$cutoff = (Get-Date).AddDays(-$Days)
$apps = @{}

$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist'
foreach ($guid in Get-ChildItem $root) {
    $key = Get-Item (Join-Path $guid.PSPath 'Count')
    if (-not $key) { continue }

    foreach ($valueName in $key.GetValueNames()) {
        $bytes = $key.GetValue($valueName)
        if ($bytes.Length -lt 68) { continue }
        $runs = [BitConverter]::ToUInt32($bytes, 4)
        $focusMinutes = [int]([BitConverter]::ToUInt32($bytes, 12) / 60000)
        $fileTime = [BitConverter]::ToInt64($bytes, 60)
        if ($runs -eq 0 -or $fileTime -le 0) { continue }
        $lastUsed = [DateTime]::FromFileTime($fileTime)
        if ($lastUsed -lt $cutoff) { continue }

        $raw = Rot13 $valueName
        $path = Resolve-KnownFolder $raw
        if (-not $path) { continue }

        # Trois formes possibles : un raccourci .lnk, un .exe, ou un identifiant d'app Windows.
        $name = $null; $open = $null; $iconFile = $null; $priority = 0
        if ($path -match '\.(lnk|exe)$') {
            if (-not (Test-Path -LiteralPath $path)) { continue }
            if ($path -match '\\(WindowsApps|System32|SysWOW64|Downloads|Téléchargements|node_modules)\\') { continue }
            if ((Split-Path $path -Leaf) -match $installerPattern) { continue }
            if ($path -like '*.lnk') {
                $name = [IO.Path]::GetFileNameWithoutExtension($path) -replace ' - (Raccourci|Shortcut)$', ''
                $priority = 3
            } else {
                $name = Get-ExeName $path
                $priority = 2
            }
            $open = $path
        } else {
            if (-not $startApps.ContainsKey($raw)) { continue }
            if ($excludedIds | Where-Object { $raw.StartsWith($_, 'OrdinalIgnoreCase') }) { continue }
            $name = $startApps[$raw]
            # Les jeux Steam ont un lien "steam://..." pour identifiant : on l'ouvre directement.
            $open = if ($raw -match '^[a-z]+://') { $raw } else { "shell:AppsFolder\$raw" }
            $iconFile = Get-PackageIcon $raw
            $priority = 1
        }
        if ($excludedNames -contains $name) { continue }

        # Une même app apparaît sous plusieurs formes : on fusionne par nom.
        $id = Normalize $name
        if (-not $id) { continue }
        $existing = $apps[$id]
        if (-not $existing) {
            $apps[$id] = [pscustomobject]@{
                name = $name; open = $open; priority = $priority; iconFile = $iconFile
                runs = $runs; focusMinutes = $focusMinutes; lastUsed = $lastUsed
            }
            continue
        }
        $existing.runs = [Math]::Max($existing.runs, $runs)
        $existing.focusMinutes = [Math]::Max($existing.focusMinutes, $focusMinutes)
        if ($lastUsed -gt $existing.lastUsed) { $existing.lastUsed = $lastUsed }
        if (-not $existing.iconFile) { $existing.iconFile = $iconFile }
        if ($priority -gt $existing.priority) {
            # Un raccourci se lance et s'affiche mieux qu'un .exe ou un identifiant.
            $existing.name = $name; $existing.open = $open; $existing.priority = $priority
        }
    }
}

$result = $apps.Values |
    Sort-Object -Property @{ Expression = 'runs'; Descending = $true }, @{ Expression = 'focusMinutes'; Descending = $true } |
    Select-Object -First $Max |
    ForEach-Object {
        [pscustomobject]@{
            name = $_.name; open = $_.open; iconFile = $_.iconFile
            runs = $_.runs; focusMinutes = $_.focusMinutes; lastUsed = $_.lastUsed.ToString('o')
        }
    }
ConvertTo-Json -InputObject @($result) -Compress
