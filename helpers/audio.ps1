# Pont entre Diva et le mélangeur de volume de Windows (Core Audio).
# - Écrit sur stdout une ligne JSON à chaque changement :
#   { type: 'audio', master, muted, apps: [{ id, name, path, volume, muted, active }],
#     outputs: [{ id, name, isDefault }] }
# - Lit sur stdin des commandes, une par ligne :
#   master <0-100> | mute <0|1> | app <0-100> <id> | appmute <0|1> <id> | output <id>
#   (id = nom du processus, ex. "Spotify" ; toutes ses sessions audio sont réglées ensemble)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Les interfaces COM de Core Audio ne sont pas exposées à .NET : on les déclare.
# Seul l'ordre des méthodes compte ; celles qu'on n'appelle jamais sont des emplacements vides.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DivaAudio {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator {}

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey {
        public Guid FormatId;
        public int PropertyId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant {
        public ushort Type;
        public ushort Reserved1, Reserved2, Reserved3;
        public IntPtr Value;
        public IntPtr Padding;
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount();
        int GetAt();
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    }

    // Interface non documentée de Windows, la seule qui change la sortie par défaut.
    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class PolicyConfigClient {}

    [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig {
        int GetMixFormat();
        int GetDeviceFormat();
        int ResetDeviceFormat();
        int SetDeviceFormat();
        int GetProcessingPeriod();
        int SetProcessingPeriod();
        int GetShareMode();
        int SetShareMode();
        int GetPropertyValue();
        int SetPropertyValue();
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
        int RegisterControlChangeNotify();
        int UnregisterControlChangeNotify();
        int GetChannelCount();
        int SetMasterVolumeLevel();
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        int GetMasterVolumeLevel();
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel();
        int SetChannelVolumeLevelScalar();
        int GetChannelVolumeLevel();
        int GetChannelVolumeLevelScalar();
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
        int GetAudioSessionControl();
        int GetSimpleAudioVolume();
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
    }

    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
        [PreserveSig] int GetState(out int state);
        int GetDisplayName();
        int SetDisplayName();
        int GetIconPath();
        int SetIconPath();
        int GetGroupingParam();
        int SetGroupingParam();
        int RegisterAudioSessionNotification();
        int UnregisterAudioSessionNotification();
        int GetSessionIdentifier();
        int GetSessionInstanceIdentifier();
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume {
        [PreserveSig] int SetMasterVolume(float level, ref Guid context);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    public class AudioOutput {
        public string Id;
        public string Name;
        public bool IsDefault;
    }

    public class AppAudio {
        public string Id;
        public string Name;
        public string Path;
        public int Volume;
        public bool Muted;
        public bool Active;
    }

    public static class Mixer {
        static Guid context = Guid.Empty;

        // Périphérique de sortie par défaut, relu à chaque appel : il peut changer (casque, HDMI...).
        static IMMDevice Speakers() {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0 /* rendu */, 1 /* multimédia */, out device));
            return device;
        }

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PropVariant value);

        static string FriendlyName(IMMDevice device) {
            IPropertyStore properties;
            Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0 /* lecture */, out properties));
            // PKEY_Device_FriendlyName
            var key = new PropertyKey { FormatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), PropertyId = 14 };
            PropVariant value;
            Marshal.ThrowExceptionForHR(properties.GetValue(ref key, out value));
            string name = value.Type == 31 /* VT_LPWSTR */ ? Marshal.PtrToStringUni(value.Value) : null;
            PropVariantClear(ref value);
            return name;
        }

        public static List<AudioOutput> GetOutputs() {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            string defaultId;
            Speakers().GetId(out defaultId);
            IMMDeviceCollection devices;
            Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0 /* rendu */, 1 /* actifs */, out devices));
            int count;
            devices.GetCount(out count);
            var outputs = new List<AudioOutput>();
            for (int i = 0; i < count; i++) {
                IMMDevice device;
                if (devices.Item(i, out device) != 0) continue;
                string id;
                device.GetId(out id);
                outputs.Add(new AudioOutput { Id = id, Name = FriendlyName(device) ?? id, IsDefault = id == defaultId });
            }
            return outputs;
        }

        // Rôles 0 et 1 : console et multimédia, comme le menu son de Windows. Le rôle 2
        // (communications) ne bouge pas : les appels restent sur le casque choisi.
        public static void SetOutput(string id) {
            var policy = (IPolicyConfig)new PolicyConfigClient();
            for (int role = 0; role < 2; role++) Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, role));
        }

        static T Activate<T>(string iid) {
            var guid = new Guid(iid);
            object result;
            Marshal.ThrowExceptionForHR(Speakers().Activate(ref guid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out result));
            return (T)result;
        }

        static IAudioEndpointVolume Endpoint() {
            return Activate<IAudioEndpointVolume>("5CDF2C82-841E-4546-9722-0CF74078229A");
        }

        public static int GetMaster() {
            float level;
            Endpoint().GetMasterVolumeLevelScalar(out level);
            return (int)Math.Round(level * 100);
        }

        public static bool GetMuted() {
            bool muted;
            Endpoint().GetMute(out muted);
            return muted;
        }

        public static void SetMaster(int percent) {
            Endpoint().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, percent)) / 100f, ref context);
        }

        public static void SetMuted(bool muted) {
            Endpoint().SetMute(muted, ref context);
        }

        // Toutes les sessions audio vivantes, avec le processus qui les possède.
        static List<KeyValuePair<Process, IAudioSessionControl2>> Sessions() {
            var result = new List<KeyValuePair<Process, IAudioSessionControl2>>();
            var manager = Activate<IAudioSessionManager2>("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            IAudioSessionEnumerator sessions;
            Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
            int count;
            sessions.GetCount(out count);
            for (int i = 0; i < count; i++) {
                IAudioSessionControl2 session;
                if (sessions.GetSession(i, out session) != 0) continue;
                int state;
                uint pid;
                session.GetState(out state);
                session.GetProcessId(out pid);
                // 2 = session expirée ; IsSystemSoundsSession renvoie 0 pour les sons système.
                if (state == 2 || pid == 0 || session.IsSystemSoundsSession() == 0) continue;
                try {
                    result.Add(new KeyValuePair<Process, IAudioSessionControl2>(Process.GetProcessById((int)pid), session));
                } catch (ArgumentException) {
                    // Processus terminé entre-temps.
                }
            }
            return result;
        }

        public static List<AppAudio> GetApps() {
            var apps = new Dictionary<string, AppAudio>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in Sessions()) {
                var process = pair.Key;
                var volume = (ISimpleAudioVolume)pair.Value;
                int state;
                pair.Value.GetState(out state);
                AppAudio app;
                if (!apps.TryGetValue(process.ProcessName, out app)) {
                    app = new AppAudio { Id = process.ProcessName, Name = process.ProcessName };
                    try {
                        app.Path = process.MainModule.FileName;
                        // La description est le plus lisible ("Spotify"), sauf quand elle reprend
                        // le nom du fichier ("wallpaper64") : le nom du produit est alors meilleur.
                        var info = process.MainModule.FileVersionInfo;
                        foreach (var candidate in new[] { info.FileDescription, info.ProductName }) {
                            if (String.IsNullOrWhiteSpace(candidate)) continue;
                            app.Name = candidate.Trim();
                            if (!String.Equals(app.Name, process.ProcessName, StringComparison.OrdinalIgnoreCase)) break;
                        }
                    } catch (Exception) {
                        // Processus protégé ou d'une autre architecture : on garde son nom brut.
                    }
                    float level;
                    bool muted;
                    volume.GetMasterVolume(out level);
                    volume.GetMute(out muted);
                    app.Volume = (int)Math.Round(level * 100);
                    app.Muted = muted;
                    apps[process.ProcessName] = app;
                }
                if (state == 1) app.Active = true;
            }
            return new List<AppAudio>(apps.Values);
        }

        public static void SetApp(string id, int percent) {
            foreach (var pair in Sessions()) {
                if (!String.Equals(pair.Key.ProcessName, id, StringComparison.OrdinalIgnoreCase)) continue;
                ((ISimpleAudioVolume)pair.Value).SetMasterVolume(Math.Max(0, Math.Min(100, percent)) / 100f, ref context);
            }
        }

        public static void SetAppMuted(string id, bool muted) {
            foreach (var pair in Sessions()) {
                if (!String.Equals(pair.Key.ProcessName, id, StringComparison.OrdinalIgnoreCase)) continue;
                ((ISimpleAudioVolume)pair.Value).SetMute(muted, ref context);
            }
        }
    }
}
'@

function Send-AudioCommand([string]$line) {
    $command, $value, $id = $line -split ' ', 3
    switch ($command) {
        'master'  { [DivaAudio.Mixer]::SetMaster([int]$value) }
        'mute'    { [DivaAudio.Mixer]::SetMuted($value -eq '1') }
        'app'     { [DivaAudio.Mixer]::SetApp($id, [int]$value) }
        'appmute' { [DivaAudio.Mixer]::SetAppMuted($id, $value -eq '1') }
        'output'  {
            [DivaAudio.Mixer]::SetOutput($value)
            $script:outputs = $null
        }
    }
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pendingLine = $stdin.ReadLineAsync()
$lastJson = ''
$outputs = $null
$tick = 0

while ($true) {
    while ($pendingLine.IsCompleted) {
        $line = $pendingLine.Result
        if ($null -eq $line) { exit 0 }  # Diva s'est fermée
        try { Send-AudioCommand $line.Trim() } catch { [Console]::Error.WriteLine($_.Exception.Message) }
        $pendingLine = $stdin.ReadLineAsync()
    }

    try {
        # Apps actives d'abord, puis par nom ; on ne garde pas Diva elle-même.
        $apps = [DivaAudio.Mixer]::GetApps() |
            Where-Object { $_.Id -ne 'electron' -and $_.Id -ne 'Diva' } |
            Sort-Object @{ Expression = 'Active'; Descending = $true }, Name |
            ForEach-Object {
                [ordered]@{ id = $_.Id; name = $_.Name; path = $_.Path; volume = $_.Volume; muted = $_.Muted; active = $_.Active }
            }
        # Les sorties changent rarement : relues toutes les 2 s (ou tout de suite après un changement).
        if ($null -eq $outputs -or $tick % 7 -eq 0) {
            $outputs = @([DivaAudio.Mixer]::GetOutputs() | ForEach-Object {
                [ordered]@{ id = $_.Id; name = $_.Name; isDefault = $_.IsDefault }
            })
        }
        $tick++
        $state = [ordered]@{
            type    = 'audio'
            master  = [DivaAudio.Mixer]::GetMaster()
            muted   = [DivaAudio.Mixer]::GetMuted()
            apps    = @($apps)
            outputs = $outputs
        }
        $json = ConvertTo-Json -InputObject $state -Compress -Depth 4
        if ($json -ne $lastJson) {
            [Console]::Out.WriteLine($json)
            [Console]::Out.Flush()
            $lastJson = $json
        }
    } catch {
        # Pas de périphérique de sortie (casque débranché...) : on retente au tour suivant.
    }
    Start-Sleep -Milliseconds 300
}
