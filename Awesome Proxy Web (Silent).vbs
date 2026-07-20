' ============================================================
'  Awesome Proxy - silent WEB launcher
'  Starts the backend + web UI with NO console windows and
'  opens the app in your default browser.
'
'  Note: the background processes keep running until you end
'  them in Task Manager (look for node.exe). Prefer the
'  Electron silent launcher if you want a tray icon to quit.
' ============================================================

Option Explicit

Dim shell, fso, scriptDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

' First-run dependency install (hidden, wait).
If Not fso.FolderExists(scriptDir & "\node_modules") Then
  shell.Run "cmd /c npm install", 0, True
End If

' Start backend (hidden, don't wait).
shell.Run "cmd /c node server\index.js", 0, False

' Give the backend a moment, then start the UI (hidden).
WScript.Sleep 2000
shell.Run "cmd /c npx vite --config vite.config.web.ts", 0, False

' Open the app in the default browser.
WScript.Sleep 4000
shell.Run "http://localhost:5173", 1, False

Set shell = Nothing
Set fso = Nothing
