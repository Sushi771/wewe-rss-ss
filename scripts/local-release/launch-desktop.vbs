Option Explicit
Dim shell, files, root, node, entry, command, result, stream, detail, errorFile, argument
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
For Each argument In WScript.Arguments
  If argument = "--check" Or argument = "--reuse-only" Then command = command & " " & argument
Next
result = shell.Run(command, 0, True)
If result <> 0 Then
  detail = "WeWe-RSS could not start. See output\playwright\local-release-audit\desktop-start.jsonl"
  errorFile = root & "\output\playwright\local-release-audit\desktop-start-error.txt"
  On Error Resume Next
  If files.FileExists(errorFile) Then
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.LoadFromFile errorFile
    If Err.Number = 0 Then detail = stream.ReadText
    stream.Close
  End If
  On Error GoTo 0
  MsgBox detail, vbExclamation, "WeWe-RSS"
End If
WScript.Quit result
