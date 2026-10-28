# Pont entre Diva et le contrôle média de Windows (le même que le mini-lecteur du volume).
# - Écrit sur stdout une ligne JSON à chaque changement : morceau, artiste, état, pochette.
# - Lit sur stdin des commandes, une par ligne : toggle | next | prev
# Fonctionne avec toute app qui s'enregistre auprès de Windows (Spotify, navigateurs, ...).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

# PowerShell ne sait pas attendre une opération WinRT : on la convertit en Task .NET.
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($operation, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $null = $task.Wait(5000)
    $task.Result
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# Le flux WinRT arrive comme objet COM : un appel direct ne trouve pas la surcharge, la réflexion si.
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod(
    'AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

function Get-Thumbnail($props) {
    if (-not $props.Thumbnail) { return $null }
    try {
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $netStream = $asStreamForRead.Invoke($null, @($stream))
        $buffer = New-Object System.IO.MemoryStream
        $netStream.CopyTo($buffer)
        $netStream.Dispose()
        return 'data:image/png;base64,' + [Convert]::ToBase64String($buffer.ToArray())
    } catch {
        return $null
    }
}

function Send-MediaCommand($session, [string]$command) {
    if (-not $session) { return }
    switch ($command) {
        'toggle' { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
        'next'   { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
    }
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pendingLine = $stdin.ReadLineAsync()
$lastJson = ''
$lastTrackKey = ''
$thumbnail = $null

while ($true) {
    $session = $manager.GetCurrentSession()

    while ($pendingLine.IsCompleted) {
        $line = $pendingLine.Result
        if ($null -eq $line) { exit 0 }  # Diva s'est fermée
        Send-MediaCommand $session $line.Trim()
        $pendingLine = $stdin.ReadLineAsync()
    }

    $state = @{ type = 'media'; active = $false }
    if ($session) {
        try {
            $props = Await ($session.TryGetMediaPropertiesAsync()) `
                ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $trackKey = "$($props.Title)|$($props.Artist)"
            if ($trackKey -ne $lastTrackKey) {
                $thumbnail = Get-Thumbnail $props
                $lastTrackKey = $trackKey
            }
            $state = @{
                type      = 'media'
                active    = $true
                app       = $session.SourceAppUserModelId
                title     = $props.Title
                artist    = $props.Artist
                playing   = $session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'
                thumbnail = $thumbnail
            }
        } catch {
            # La session peut disparaître entre deux lectures : on retente au tour suivant.
        }
    }

    $json = $state | ConvertTo-Json -Compress
    if ($json -ne $lastJson) {
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
        $lastJson = $json
    }
    Start-Sleep -Milliseconds 400
}
