# list-device-files.ps1 — Walk the HiBy R4 via Windows Shell MTP namespace
# Writes result to a JSON file (avoids stdout encoding/buffer issues).
#
# Music folder detection is flexible:
#   - If -MusicFolder is supplied, match it case-insensitively (regex).
#   - Otherwise try the common candidates: Music, MUSIC, music, Music Library,
#     My Music, MyMusic.
#   - If no music folder is found in a volume, treat the volume root itself as
#     the music root. Useful for SD cards that drop albums directly at the top.

param(
  [string]$DeviceName  = "R4",
  [string]$OutFile     = "",
  [string]$MusicFolder = ""
)

$shell  = New-Object -ComObject Shell.Application
$thisPC = $shell.Namespace(17)

$device = $null
foreach ($item in $thisPC.Items()) {
    if ($item.Name -match [regex]::Escape($DeviceName) -or $item.Name -match 'HiBy') {
        $device = $item; break
    }
}

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Depth 5 -Compress
    if ($OutFile -ne "") {
        [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.Encoding]::UTF8)
    } else {
        Write-Output $json
    }
}

if ($null -eq $device) {
    Write-Result @{ connected = $false; albums = @(); albumCount = 0; error = "Device not found in This PC. Make sure it is connected in MTP mode." }
    exit 0
}

# Build the list of music-folder name regexes to try. HiByMusic is the HiBy
# stock app's internal-storage folder; Music is the conventional SD-card name.
if ($MusicFolder -ne "") {
    $musicCandidates = @([regex]::Escape($MusicFolder))
} else {
    $musicCandidates = @('^Music$', '^MUSIC$', '^music$', '^HiByMusic$', '^Music Library$', '^My Music$', '^MyMusic$')
}

$albums = [System.Collections.Generic.List[hashtable]]::new()
$volumesScanned = [System.Collections.Generic.List[string]]::new()
$musicRootsFound = [System.Collections.Generic.List[string]]::new()
$deviceFolder = $device.GetFolder

# When the HiBy's screen is locked/asleep, the device shows up in This PC
# but its volumes don't enumerate. Retry once with a fresh Shell.Application
# instance — that's often enough to wake the namespace back up.
$initialVolumes = @($deviceFolder.Items())
if ($initialVolumes.Count -eq 0) {
    Start-Sleep -Seconds 2
    $shell2  = New-Object -ComObject Shell.Application
    $thisPC2 = $shell2.Namespace(17)
    foreach ($item in $thisPC2.Items()) {
        if ($item.Name -match [regex]::Escape($DeviceName) -or $item.Name -match 'HiBy') {
            $device = $item; $deviceFolder = $item.GetFolder; break
        }
    }
}
if (@($deviceFolder.Items()).Count -eq 0) {
    Write-Result @{
        connected   = $true
        deviceName  = $device.Name
        albums      = @()
        albumCount  = 0
        error       = "Device is connected but no volumes are visible. The HiBy screen is most likely locked - tap it to wake the device and try again."
    }
    exit 0
}

function Add-AlbumsFromMusicRoot($musicFolder, $volumeName) {
    foreach ($artistItem in $musicFolder.Items()) {
        if (-not $artistItem.IsFolder) { continue }
        $artistFolder = $artistItem.GetFolder
        if ($null -eq $artistFolder) { continue }

        $subItems = @($artistFolder.Items())
        $hasSubFolders = $false
        foreach ($sub in $subItems) {
            if ($sub.IsFolder) { $hasSubFolders = $true; break }
        }

        if ($hasSubFolders) {
            # Two-level: Music / Artist / Album
            foreach ($albumItem in $subItems) {
                if (-not $albumItem.IsFolder) { continue }
                $albums.Add(@{
                    key    = "$($artistItem.Name) $([char]0x2014) $($albumItem.Name)"
                    name   = $albumItem.Name
                    artist = $artistItem.Name
                    album  = $albumItem.Name
                    volume = $volumeName
                })
            }
        } else {
            # Flat: Music / Album-folder (no artist split)
            $albums.Add(@{
                key    = $artistItem.Name
                name   = $artistItem.Name
                artist = $artistItem.Name
                album  = ''
                volume = $volumeName
            })
        }
    }
}

foreach ($volume in $deviceFolder.Items()) {
    if (-not $volume.IsFolder) { continue }
    $volFolder = $volume.GetFolder
    if ($null -eq $volFolder) { continue }
    $volumesScanned.Add($volume.Name)

    # Try each candidate music-folder name on this volume.
    $musicItem = $null
    foreach ($candidate in $musicCandidates) {
        foreach ($item in $volFolder.Items()) {
            if ($item.IsFolder -and $item.Name -match $candidate) { $musicItem = $item; break }
        }
        if ($null -ne $musicItem) { break }
    }

    if ($null -ne $musicItem) {
        $musicFolderObj = $musicItem.GetFolder
        if ($null -ne $musicFolderObj) {
            $musicRootsFound.Add("$($volume.Name)\$($musicItem.Name)")
            Add-AlbumsFromMusicRoot $musicFolderObj $volume.Name
        }
    } else {
        # Fallback: no Music folder found — treat the volume root itself as the
        # music root. Skips system folders we shouldn't index.
        $skipNames = @('System Volume Information', '$RECYCLE.BIN', 'LOST.DIR', 'Android', '.thumbnails', 'Playlists')
        $rootHasUsableFolders = $false
        foreach ($item in $volFolder.Items()) {
            if (-not $item.IsFolder) { continue }
            if ($skipNames -contains $item.Name) { continue }
            $rootHasUsableFolders = $true; break
        }
        if ($rootHasUsableFolders) {
            $musicRootsFound.Add("$($volume.Name) (root, no Music folder)")
            Add-AlbumsFromMusicRoot $volFolder $volume.Name
        }
    }
}

Write-Result @{
    connected     = $true
    deviceName    = $device.Name
    albums        = $albums.ToArray()
    albumCount    = $albums.Count
    volumes       = $volumesScanned.ToArray()
    musicRoots    = $musicRootsFound.ToArray()
}
