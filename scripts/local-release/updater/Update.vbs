Option Explicit
Dim shell, fso, base, command, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -STA -File " & Chr(34) & base & "\Update.ps1" & Chr(34)
result = shell.Run(command, 0, True)
If result <> 0 Then MsgBox "Unable to open the updater. Please use the complete signed installer.", 16, "WeWe-RSS Update"
