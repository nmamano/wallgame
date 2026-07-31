' Windows-side launcher for scripts/wsl-keepalive.sh. Run from Task Scheduler
' at logon and on a short repeating interval, so that whatever takes WSL down -
' idle teardown, a wsl --update, a crash - it comes back on its own.
'
' Usage:
'   wscript.exe wsl-keepalive.vbs <distro> <linux-user> <script-path-in-wsl>
' e.g.
'   wscript.exe C:\path\wsl-keepalive.vbs Ubuntu myuser /home/myuser/wsl-keepalive.sh
'
' The 0 in .Run means no window. Without it a console flashes on the desktop on
' every interval - 288 times a day at 5-minute spacing - and the task gets
' switched off by an irritated human.
'
' The True means WAIT for wsl.exe and propagate its exit code. It was False at
' first, which meant the task reported Last Result: 0 even while the VM was
' wedged and unreachable: write-only reassurance. It reported success at
' 22:19:44 on 2026-07-30 in the middle of exactly such an outage. Give the
' scheduled task an execution time limit (2 minutes is plenty) so that waiting
' on a hung VM fails loudly instead of blocking forever.
'
' Register the task (PowerShell, adjust paths and names):
'   $a = New-ScheduledTaskAction -Execute "wscript.exe" `
'          -Argument "C:\path\wsl-keepalive.vbs Ubuntu myuser /home/myuser/wsl-keepalive.sh"
'   $t1 = New-ScheduledTaskTrigger -AtLogOn
'   $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
'          -RepetitionInterval (New-TimeSpan -Minutes 5)
'   $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
'          -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
'   Register-ScheduledTask -TaskName "WSL Keepalive" -Action $a -Trigger $t1,$t2 -Settings $s -Force
'
' CAUTION when recovering a hung VM: if you disable this task so it cannot race
' a `wsl --shutdown`, RE-ENABLE IT IMMEDIATELY after the restart. Nothing else
' holds the VM open, so it will die again within a minute and look like the
' recovery failed.
Option Explicit

Dim args, rc
Set args = WScript.Arguments
If args.Count < 3 Then
  WScript.Echo "usage: wscript.exe wsl-keepalive.vbs <distro> <linux-user> <script-path-in-wsl>"
  WScript.Quit 2
End If

rc = CreateObject("WScript.Shell").Run( _
  "wsl.exe -d " & args(0) & " -u " & args(1) & " --exec " & args(2), 0, True)
WScript.Quit rc
