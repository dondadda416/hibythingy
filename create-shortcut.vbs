Dim ws, s, projectDir
Set ws = CreateObject("WScript.Shell")
projectDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

' Try both real desktop and OneDrive desktop
Dim paths(2)
paths(0) = "C:\Users\user\Desktop"
paths(1) = "C:\Users\user\OneDrive\Desktop"
paths(2) = ws.SpecialFolders("Desktop")

Dim i
For i = 0 To 2
    On Error Resume Next
    Set s = ws.CreateShortcut(paths(i) & "\HiBy Hub.lnk")
    s.TargetPath = projectDir & "start.bat"
    s.WorkingDirectory = projectDir
    s.WindowStyle = 1
    s.Description = "HiBy Hub - Music Control Center"
    s.Save
    On Error GoTo 0
Next

MsgBox "Done! Check your Desktop for HiBy Hub.", 64, "HiBy Hub"
