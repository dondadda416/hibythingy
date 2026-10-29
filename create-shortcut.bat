@echo off
:: Write a tiny VBScript, run it, then delete it
set VBS=%TEMP%\make_hiby_shortcut.vbs
set TARGET=%~dp0start.bat
set WORKDIR=%~dp0

echo Set ws = CreateObject("WScript.Shell") > "%VBS%"
echo Set s = ws.CreateShortcut(ws.SpecialFolders("Desktop") ^& "\HiBy Hub.lnk") >> "%VBS%"
echo s.TargetPath = "%TARGET%" >> "%VBS%"
echo s.WorkingDirectory = "%WORKDIR%" >> "%VBS%"
echo s.WindowStyle = 1 >> "%VBS%"
echo s.Description = "HiBy Hub - Music Control Center" >> "%VBS%"
echo s.Save >> "%VBS%"

cscript //nologo "%VBS%"
del "%VBS%"

echo.
echo  Done! HiBy Hub shortcut is on your Desktop.
echo.
pause
