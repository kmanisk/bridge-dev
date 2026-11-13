param([Parameter(Mandatory=$true)][int]$RootProcessId)
$ErrorActionPreference = 'Stop'
# Toolhelp is local and does not depend on WMI, WinRM or a resident helper.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BridgeDevProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct Entry {
    public uint Size, Usage, Id;
    public IntPtr Heap;
    public uint Module, Threads, Parent;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string File;
  }
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  public static int[] Descendants(int root) {
    var rows = new List<Entry>();
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      var entry = new Entry(); entry.Size = (uint)Marshal.SizeOf(typeof(Entry));
      if (Process32FirstW(snapshot, ref entry)) do { rows.Add(entry); } while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    var queue = new Queue<int>(); var visited = new HashSet<int>(); var found = new List<int>();
    queue.Enqueue(root); visited.Add(root);
    while (queue.Count > 0) {
      var parent = queue.Dequeue();
      foreach (var row in rows) if (row.Parent == parent && visited.Add((int)row.Id)) { found.Add((int)row.Id); queue.Enqueue((int)row.Id); }
    }
    found.Reverse(); return found.ToArray();
  }
}
'@
foreach ($ChildProcessId in [BridgeDevProcessTree]::Descendants($RootProcessId)) {
  if ($ChildProcessId -ne $PID) {
    $ChildProcess = Get-Process -Id $ChildProcessId -ErrorAction SilentlyContinue
    if ($ChildProcess) {
      try { $ChildProcess.Kill() } catch [System.InvalidOperationException] {}
      if (-not $ChildProcess.WaitForExit(3000)) { throw 'Provider descendant did not terminate' }
    }
  }
}
# This path handles an already-exited root. Never kill a reused root PID.
exit 0
