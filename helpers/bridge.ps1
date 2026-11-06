# Pont entre Diva et Windows : un seul processus PowerShell pour le média et le volume
# (chaque processus embarque tout .NET, environ 40 Mo : un seul au lieu de deux).
# - Écrit sur stdout une ligne JSON par changement, avec "channel" : media | audio.
# - Lit sur stdin une commande par ligne : media <commande> | audio <commande> | pace fast|slow
#   (pace slow : aucun widget visible, les relevés s'espacent).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Write-Message([string]$channel, $message) {
    $message['channel'] = $channel
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $message -Compress -Depth 4))
    [Console]::Out.Flush()
}

. (Join-Path $PSScriptRoot 'media.ps1')
. (Join-Path $PSScriptRoot 'audio.ps1')

$PACE = @{ fast = 400; slow = 2000 } # millisecondes entre deux relevés
$interval = $PACE.fast
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pendingLine = $stdin.ReadLineAsync()

while ($true) {
    while ($pendingLine.IsCompleted) {
        $line = $pendingLine.Result
        if ($null -eq $line) { exit 0 } # Diva s'est fermée
        $channel, $command = $line.Trim() -split ' ', 2
        try {
            switch ($channel) {
                'media' { Invoke-MediaCommand $command }
                'audio' { Invoke-AudioCommand $command }
                'pace'  { if ($PACE.ContainsKey($command)) { $interval = $PACE[$command] } }
            }
        } catch {
            [Console]::Error.WriteLine($_.Exception.Message)
        }
        $pendingLine = $stdin.ReadLineAsync()
    }

    Get-MediaMessages
    Get-AudioMessages

    # Attente découpée : une commande (clic sur pause...) est traitée tout de suite, même au ralenti.
    $deadline = [DateTime]::UtcNow.AddMilliseconds($interval)
    while ([DateTime]::UtcNow -lt $deadline -and -not $pendingLine.IsCompleted) {
        Start-Sleep -Milliseconds 50
    }
}
