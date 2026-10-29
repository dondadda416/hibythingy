# push-playlist.ps1
# Copies a .m3u8 (or .m3u) playlist file to the HiBy SD card via MTP.
#
# HiBy quirk: the HiByMusic app on the R4 doesn't auto-scan playlists in
# Music\Playlists\, and the stock player is inconsistent about where it looks.
# So we push to TWO locations defensively:
#   SD:\Music\Playlists\<file>   — where it logically belongs
#   SD:\Playlists\<file>         — fallback the stock player tends to see
#
# The user can pick which one their player likes and clear the other.

param(
  [Parameter(Mandatory=$true)] [string]$SourceFile,
  [string]$DeviceMatch = "R4|HiBy|RS2|RS6|R3",
  [string]$OutFile = ""
)

function Log($msg) { Write-Host "LOG: $msg" }

function Bail($msg) {
  $j = [PSCustomObject]@{ ok = $false; error = $msg } | ConvertTo-Json -Compress
  if ($script:OutFile -ne "") {
    [System.IO.File]::WriteAllText($script:OutFile, $j, [System.Text.Encoding]::UTF8)
  } else { Write-Output $j }
  exit 1
}

# Top-level safety net: any unhandled exception below gets written into the
# result file with a useful message instead of dying silently.
$ErrorActionPreference = 'Continue'   # don't auto-terminate; we want messages

# ── IFileOperation interop ────────────────────────────────────────────────────
# Shell.Application.CopyHere uses an older Shell code path that the R4's MTP
# firmware does not honour when merging a file into an existing MTP folder
# (the call returns success but nothing is written). IFileOperation is the
# modern API that Windows Explorer's drag-drop uses, and the device DOES
# honour it. We use it to copy the playlist file directly into the device's
# Music\Playlists folder.
Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace HubFileOp {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    uint Advise(IntPtr pfops, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOperationFlags(uint dwOperationFlags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);
    void SetProgressDialog(IntPtr popd);
    void SetProperties(IntPtr pproparray);
    void SetOwnerWindow(IntPtr hwndOwner);
    void ApplyPropertiesToItem(IShellItem psiItem);
    void ApplyPropertiesToItems(IntPtr punkItems);
    void RenameItem(IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IntPtr pfopsItem);
    void RenameItems(IntPtr pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
    void MoveItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IntPtr pfopsItem);
    void MoveItems(IntPtr punkItems, IShellItem psiDestinationFolder);
    void CopyItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszCopyName, IntPtr pfopsItem);
    void CopyItems(IntPtr punkItems, IShellItem psiDestinationFolder);
    void DeleteItem(IShellItem psiItem, IntPtr pfopsItem);
    void DeleteItems(IntPtr punkItems);
    void NewItem(IShellItem psiDestinationFolder, uint dwFileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string pszName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, IntPtr pfopsItem);
    void PerformOperations();
    void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool pfAnyOperationsAborted);
  }
  public static class Api {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
      [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
      [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
      [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    // Get a PIDL from a shell COM object (Shell32 FolderItem / Folder). MTP
    // folders have no round-trippable parsing path, so we pull the PIDL
    // directly from the COM object the Shell.Application gave us.
    [DllImport("shell32.dll", PreserveSig = false)]
    static extern void SHGetIDListFromObject(
      [MarshalAs(UnmanagedType.IUnknown)] object iUnknown, out IntPtr ppidl);
    [DllImport("shell32.dll", PreserveSig = false)]
    static extern void SHCreateItemFromIDList(
      IntPtr pidl, [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
      [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    [DllImport("ole32.dll")]
    static extern void CoTaskMemFree(IntPtr pv);

    static readonly Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
    // FOF_SILENT(4) | FOF_NOCONFIRMATION(0x10) | FOF_NOCONFIRMMKDIR(0x200) | FOF_NOERRORUI(0x400)
    const uint FLAGS = 0x4 | 0x10 | 0x200 | 0x400;

    static IShellItem ItemFromObject(object comObject) {
      IntPtr pidl = IntPtr.Zero;
      SHGetIDListFromObject(comObject, out pidl);
      IShellItem si;
      try { SHCreateItemFromIDList(pidl, IID_IShellItem, out si); }
      finally { if (pidl != IntPtr.Zero) CoTaskMemFree(pidl); }
      return si;
    }

    // sourceFile: a regular filesystem path (parsing name works fine).
    // destFolderObject: the Shell32 Folder/FolderItem COM object for the
    //   destination MTP folder (we extract its PIDL).
    // existingFileObject: optional Shell32 FolderItem for a same-named file
    //   already at the destination — if supplied, it's deleted first in the
    //   same operation batch so the result is a clean overwrite. IFileOperation
    //   honours FOF_NOCONFIRMATION for the delete too (no dialog), which is
    //   what Shell.Application's delete verb failed to do.
    public static string CopyInto(string sourceFile, object destFolderObject, string copyAsName, object existingFileObject) {
      IShellItem src;
      SHCreateItemFromParsingName(sourceFile, IntPtr.Zero, IID_IShellItem, out src);
      IShellItem dst = ItemFromObject(destFolderObject);

      Type t = Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09"));
      IFileOperation op = (IFileOperation)Activator.CreateInstance(t);
      op.SetOperationFlags(FLAGS);
      if (existingFileObject != null) {
        IShellItem old = ItemFromObject(existingFileObject);
        op.DeleteItem(old, IntPtr.Zero);
      }
      op.CopyItem(src, dst, copyAsName, IntPtr.Zero);
      op.PerformOperations();
      bool aborted; op.GetAnyOperationsAborted(out aborted);
      System.Runtime.InteropServices.Marshal.ReleaseComObject(op);
      return aborted ? "aborted" : "ok";
    }
  }
}
'@

try {

if (-not (Test-Path $SourceFile)) { Bail "Source file not found: $SourceFile" }

# Keep the original filename — no timestamp. IFileOperation honours
# FOF_NOCONFIRMATION, so we can delete-then-copy in one batch for a clean
# silent overwrite (the old CopyHere path couldn't, which is why we briefly
# resorted to timestamped names).
$origFileName = Split-Path $SourceFile -Leaf
$fileName = $origFileName
Log "Pushing playlist: $fileName"

# Find HiBy device
$shell  = New-Object -ComObject Shell.Application
$thisPC = $shell.NameSpace(17)

$device = $null
foreach ($item in $thisPC.Items()) {
  if ($item.Name -match $DeviceMatch) { $device = $item; break }
}
if ($null -eq $device) { Bail "HiBy device not found. Connect via USB in MTP mode." }
Log "Device: $($device.Name)"

# Find SD card volume — picks the one whose name contains SD/Card/External.
# Falls back to the first volume if no match (single-volume DAPs).
#
# When the HiBy's screen is locked/asleep, Windows still reports the device
# as connected but the MTP volumes don't enumerate (an empty Items() list).
# A single re-query a couple of seconds later sometimes wakes the namespace
# back up — if it doesn't, we surface a clear message telling the user to
# tap the screen.
$deviceFolder = $device.GetFolder
$volumes = @($deviceFolder.Items())
if ($volumes.Count -eq 0) {
  Log "No volumes on first try - re-querying after 2s..."
  Start-Sleep -Seconds 2
  # Construct a fresh Shell.Application instance — sometimes the volume list
  # is cached on the first instance after the device went to sleep.
  $shell2 = New-Object -ComObject Shell.Application
  $thisPC2 = $shell2.NameSpace(17)
  $device2 = $null
  foreach ($item in $thisPC2.Items()) {
    if ($item.Name -match $DeviceMatch) { $device2 = $item; break }
  }
  if ($null -ne $device2) {
    $deviceFolder = $device2.GetFolder
    $volumes = @($deviceFolder.Items())
  }
}
if ($volumes.Count -eq 0) {
  Bail "No volumes found on $($device.Name). The device is connected but its SD card is not visible - this almost always means the HiBy screen is locked. Tap the screen to wake it, then try again."
}

$sdVol = $null
foreach ($v in $volumes) {
  if ($v.Name -match "SD|Card|MicroSD|External") { $sdVol = $v; break }
}
if ($null -eq $sdVol) { $sdVol = $volumes[0] }
Log "Volume: $($sdVol.Name)"
$sdFolder = $sdVol.GetFolder

# Stage the file in two parallel folders inside %TEMP% so we can copy each as
# a folder-into-folder operation (CopyHere with a file is unreliable on MTP).
$tempRoot     = Join-Path $env:TEMP ("hiby-playlist-" + (Get-Random))
$tempMusicPL  = Join-Path (Join-Path $tempRoot "Music") "Playlists"
$tempRootPL   = Join-Path $tempRoot "Playlists"
New-Item -ItemType Directory -Path $tempMusicPL -Force | Out-Null
New-Item -ItemType Directory -Path $tempRootPL  -Force | Out-Null
Copy-Item -LiteralPath $SourceFile -Destination (Join-Path $tempMusicPL $fileName)
Copy-Item -LiteralPath $SourceFile -Destination (Join-Path $tempRootPL  $fileName)
Log "Staged in two temp folders"

# CopyHere flags: 4=no dialog, 16=yes-to-all, 512=auto-create-dirs, 1024=no-error-ui
# Flag 16 = "yes to all" means if a file with the same name exists at the
# destination it is overwritten, which is what we want for playlist refresh.
$copyFlags = 4 + 16 + 512 + 1024

$pushed = [System.Collections.Generic.List[string]]::new()
$errors = [System.Collections.Generic.List[string]]::new()

# ── Copy strategy ────────────────────────────────────────────────────────────
# HiByMusic on the R4 scans BOTH SD:\Music\Playlists\ and SD:\Playlists\ —
# pushing to both creates two HiByMusic entries per playlist (name + "name 1"
# auto-suffix). To avoid duplicates we now push to ONE canonical location.
# SD root \Playlists\ is the choice — it's where the stock HiByMusic app
# expects user playlists, and it doesn't require a Music folder to exist
# first.
#
# CopyHere with flags 16+512 will create Playlists/ at the SD root if it
# doesn't exist and merge the file in if it does, so we don't need any
# pre-walk of the device namespace.

# Use the EXACT shape that album pushes use, because that's the only shape
# we've proven works on this MTP firmware:
#
#   stage      : %TEMP%\<random>\Music\Playlists\<timestamped>.m3u8
#   CopyHere   : <staged Playlists FOLDER>  ->  device's Music folder
#   result     : device:\Music\Playlists\<timestamped>.m3u8
#
# This mirrors the album push's "CopyHere staged Artist folder into device
# Music folder" call exactly. When the device already has a Playlists
# folder, MTP merges our staged Playlists into it (same way album pushes
# merge into an existing Artist folder). With the timestamped filename
# there's no per-file conflict during the merge, so no dialog pops.
#
# We do NOT try the "file directly into Music\Playlists" code path — MTP
# firmware on the R4 silently drops single-file CopyHere into MTP folders,
# even though the same operation as a manual drag-drop works fine. The
# Shell.Application CopyHere variant takes a different code path.

$musicFolder = $null
$musicItem = $null
try { $musicItem = $sdFolder.ParseName("Music") } catch { $musicItem = $null }
if ($null -ne $musicItem -and $musicItem.IsFolder) {
  $musicFolder = $musicItem.GetFolder
} else {
  foreach ($item in $sdFolder.Items()) {
    if ($item.Name -eq "Music") { $musicFolder = $item.GetFolder; break }
  }
}
if ($null -eq $musicFolder) {
  Bail "No 'Music' folder found at the SD card root. Plug the HiBy in via USB, make sure HiByMusic has been opened at least once (which creates the Music folder), then try again."
}

# Find or create Music\Playlists\ on the device.
# Detect existence via GetFolder (NOT IsFolder): MTP items returned by
# ParseName routinely report IsFolder=$false even for real folders, which
# made the push wrongly think Music\Playlists was missing and fall into the
# unreliable CopyHere create branch. Try ParseName.GetFolder first, then an
# Items() walk as a fallback (Items()-iterated items behave more reliably).
$preExisted = $false
$plOnDevice = $null
try {
  $plProbe = $musicFolder.ParseName("Playlists")
  if ($null -ne $plProbe) {
    $f = $null
    try { $f = $plProbe.GetFolder } catch {}
    if ($null -ne $f) { $plOnDevice = $f; $preExisted = $true }
  }
} catch {}
if (-not $preExisted) {
  foreach ($it in $musicFolder.Items()) {
    if ($it.Name -eq "Playlists") {
      $f = $null
      try { $f = $it.GetFolder } catch {}
      if ($null -ne $f) { $plOnDevice = $f; $preExisted = $true }
      break
    }
  }
}

if (-not $preExisted) {
  # Folder doesn't exist — create it by CopyHere'ing the staged Playlists
  # folder into Music. A folder CREATE (vs merge) works fine via CopyHere.
  $stagedMusicNS = $shell.NameSpace((Join-Path $tempRoot "Music"))
  if ($null -ne $stagedMusicNS) {
    $stagedPL = $null
    foreach ($it in $stagedMusicNS.Items()) {
      if ($it.Name -eq "Playlists") { $stagedPL = $it; break }
    }
    if ($null -ne $stagedPL) {
      try {
        $musicFolder.CopyHere($stagedPL, $copyFlags)
        $pushed.Add("Music\Playlists\$fileName")
        Log "Created Music\Playlists and copied file via CopyHere(folder)"
        Start-Sleep -Seconds 3
      } catch {
        $errors.Add("CopyHere(folder-create) threw: $($_.Exception.Message)")
      }
    } else {
      $errors.Add("Could not find staged Playlists folder under temp Music")
    }
  } else {
    $errors.Add("Shell.NameSpace returned null for staged Music path")
  }
} else {
  # Folder exists — merge the single file in via IFileOperation, which the
  # MTP firmware honours (unlike Shell.Application.CopyHere of a file/merge).
  # We pass the destination folder's COM object so IFileOperation can pull
  # its PIDL directly (MTP folders have no parseable path string).
  #
  # IMPORTANT: copy the REAL source file (not a staged temp copy) and use
  # IFileOperation's copy-as-name to give it the timestamped filename. The
  # earlier staged-temp approach produced 0-byte files on the device — the
  # real file is what the working manual drag-drop used.
  $destObj = $null
  try { $destObj = $plOnDevice.Self } catch {}
  if ($null -eq $destObj) {
    $errors.Add("Could not get COM object for device Music\Playlists folder")
  } else {
    # This device's MTP firmware only accepts FRESH writes — scripted
    # overwrite and delete both abort. So: use the clean original name when
    # the slot is free; if a same-named file is already there, fall back to
    # a timestamped name (a fresh write that won't abort). The #PLAYLIST
    # directive inside the file keeps the HiByMusic display name clean
    # regardless of the on-disk filename.
    $clash = $null
    try { $clash = $plOnDevice.ParseName($origFileName) } catch {}
    if ($null -ne $clash -and -not $clash.IsFolder) {
      $stem = [System.IO.Path]::GetFileNameWithoutExtension($origFileName)
      $ext  = [System.IO.Path]::GetExtension($origFileName)
      $fileName = "$stem.$(Get-Date -Format 'yyyyMMdd-HHmmss')$ext"
      Log "'$origFileName' already on device; using fresh name '$fileName' (firmware can't overwrite)"
    } else {
      $fileName = $origFileName
    }

    Log "IFileOperation copy '$SourceFile' -> device Music\Playlists as '$fileName'"
    try {
      $r = [HubFileOp.Api]::CopyInto($SourceFile, $destObj, $fileName, $null)
      if ($r -eq 'ok') {
        $pushed.Add("Music\Playlists\$fileName")
        Log "IFileOperation reported ok"
      } else {
        $errors.Add("IFileOperation result: $r")
      }
    } catch {
      $errors.Add("IFileOperation threw: $($_.Exception.Message)")
    }
  }
}

# ── Wait + verify ────────────────────────────────────────────────────────────
# Sleep so the async MTP copy flushes, then check whether the file actually
# landed by walking the device namespace via a fresh Shell.Application. This
# is the only way to distinguish "CopyHere claimed success" from "CopyHere
# actually delivered the file" — without it the script lies whenever MTP
# silently drops a copy (a known Windows quirk for folder creates at MTP
# volume roots).
Start-Sleep -Seconds 6

$verified  = $false
$verifyMsg = ""
try {
  $shellV = New-Object -ComObject Shell.Application
  $thisPCv = $shellV.NameSpace(17)
  $deviceV = $null
  foreach ($it in $thisPCv.Items()) {
    if ($it.Name -match $DeviceMatch) { $deviceV = $it; break }
  }
  if ($null -eq $deviceV) {
    $verifyMsg = "verify: device disappeared after copy"
  } else {
    $devFolderV = $deviceV.GetFolder
    $volV = $null
    foreach ($v in $devFolderV.Items()) {
      if ($v.Name -eq $sdVol.Name) { $volV = $v; break }
    }
    if ($null -eq $volV) {
      $verifyMsg = "verify: SD volume '$($sdVol.Name)' not found"
    } else {
      $volFolderV = $volV.GetFolder
      # Walk SD -> Music -> Playlists.
      $musicItemV = $null
      try { $musicItemV = $volFolderV.ParseName("Music") } catch {}
      if ($null -eq $musicItemV -or -not $musicItemV.IsFolder) {
        $verifyMsg = "verify: SD has no Music folder after copy"
      } else {
        $musicFolderV = $musicItemV.GetFolder
        $plItemV = $null
        try { $plItemV = $musicFolderV.ParseName("Playlists") } catch {}
        if ($null -eq $plItemV -or -not $plItemV.IsFolder) {
          $verifyMsg = "verify: Music\Playlists folder missing after copy (CopyHere did not create it)"
        } else {
          $plFolderV = $plItemV.GetFolder
          $fileItemV = $null
          foreach ($f in $plFolderV.Items()) {
            if ($f.Name -eq $fileName) { $fileItemV = $f; break }
          }
          if ($null -ne $fileItemV) {
            # Confirm it's not a 0-byte stub. MTP can create the entry but
            # fail to stream content; the size column (property 1) reflects
            # the real byte count.
            $sizeStr = ""
            try { $sizeStr = $plFolderV.GetDetailsOf($fileItemV, 1) } catch {}
            $isEmpty = $false
            if ($sizeStr -match '^\s*0\s' -or $sizeStr -eq '0 bytes' -or $sizeStr -eq '0') { $isEmpty = $true }
            if ($isEmpty) {
              $verifyMsg = "verify: file landed but is 0 bytes (MTP content transfer failed) - '$fileName'"
            } else {
              $verified = $true
              $verifyMsg = "verify: file present at SD:\Music\Playlists\$fileName (size: $sizeStr)"
            }
          } else {
            $verifyMsg = "verify: Music\Playlists exists but does not contain '$fileName' (preExisted=$preExisted)"
          }
        }
      }
    }
  }
} catch {
  $verifyMsg = "verify: exception while checking: $($_.Exception.Message)"
}
Log $verifyMsg

# Cleanup temp
Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
Log "Done"

# Success decision.
#
# The copy operation itself is the authoritative success signal:
#   - IFileOperation (merge into existing folder) is synchronous and reports
#     a real abort flag — if it returned 'ok', the bytes were written.
#   - CopyHere (folder-create case) is fire-and-forget, so for that path we
#     still lean on the re-walk.
#
# The post-copy namespace re-walk is ADVISORY. The Windows Portable Devices
# namespace cache routinely lags after a write, so a "file not found" result
# from the re-walk is NOT trustworthy as a failure signal. The one re-walk
# result we DO act on is "found but 0 bytes" — that's a genuine transfer
# failure worth surfacing.
$opSucceeded = ($pushed.Count -gt 0) -and ($errors.Count -eq 0)
$zeroByte    = ($verifyMsg -match '0 bytes')

if ($zeroByte) {
  $ok = $false
} elseif ($verified) {
  $ok = $true                     # re-walk positively confirmed (with content)
} elseif ($opSucceeded) {
  $ok = $true                     # copy op reported success; trust it over cache-lagged re-walk
  $verifyMsg = "$verifyMsg (copy op reported success; namespace cache may lag)"
} else {
  $ok = $false
}

$result = [PSCustomObject]@{
  ok           = $ok
  file         = $fileName
  originalName = $origFileName
  pushed       = $pushed.ToArray()
  errors       = $errors.ToArray()
  verified     = $verified
  verifyMsg    = $verifyMsg
  preExisted   = $preExisted
}
if (-not $ok) {
  $errMsg = if ($errors.Count -gt 0) { ($errors -join '; ') + ' / ' + $verifyMsg } else { $verifyMsg }
  $result | Add-Member -NotePropertyName error -NotePropertyValue $errMsg
}
$result = $result | ConvertTo-Json -Compress

if ($OutFile -ne "") {
  [System.IO.File]::WriteAllText($OutFile, $result, [System.Text.Encoding]::UTF8)
} else { Write-Output $result }

} catch {
  # Catch-all for any uncaught exception during the push (Shell COM errors,
  # filesystem issues, etc.). Write a structured result so the server's
  # frontend gets a real error message instead of an exit code.
  $msg = $_.Exception.Message
  $line = $_.InvocationInfo.ScriptLineNumber
  $j = [PSCustomObject]@{
    ok    = $false
    error = "Unhandled exception at line ${line}: $msg"
  } | ConvertTo-Json -Compress
  if ($OutFile -ne "") {
    try { [System.IO.File]::WriteAllText($OutFile, $j, [System.Text.Encoding]::UTF8) } catch {}
  } else { Write-Output $j }
  exit 1
}
