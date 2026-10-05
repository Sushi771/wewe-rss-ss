Option Explicit
Dim shell, files, root, node, entry, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName)))
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
entry = root & "\scripts\local-release\desktop-start.cjs"
If Not files.FileExists(node) Then
  MsgBox "Node.js is missing. Please install the project's required Node.js.", vbExclamation, "WeWe-RSS"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = """" & node & """ """ & entry & """"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--check" Then command = command & " --check"
End If
result = shell.Run(command, 0, True)
If result <> 0 Then
  MsgBox "WeWe-RSS could not start. See output\playwright\local-release-audit\desktop-start.jsonl", vbExclamation, "WeWe-RSS"
End If
WScript.Quit result
