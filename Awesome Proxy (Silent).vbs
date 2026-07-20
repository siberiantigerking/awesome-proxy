' ============================================================
'  Awesome Proxy - silent desktop launcher
'  Starts the native Electron desktop app with NO console
'  window. The app lives in the system tray.
'
'  Double-click this file to run Awesome Proxy in the
'  background. Right-click the tray icon to quit.
' ============================================================

Option Explicit

Dim shell, fso, scriptDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Folder this script lives in (the project root).
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

' If the app was never built, build it once (hidden, wait for completion).
If Not fso.FolderExists(scriptDir & "\dist-electron") Then
  ' 0 = hidden window, True = wait until finished
  shell.Run "cmd /c npm install && npm run build", 0, True
End If

' Launch Electron with no visible console window (0 = hidden).
cmd = "cmd /c npx electron ."
shell.Run cmd, 0, False

Set shell = Nothing
Set fso = Nothing
