using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Diagnostics;
using System.Management;
using System.Web.Script.Serialization;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
namespace WeWe.LocalRelease {
    public sealed class TcpOwner {
        public string LocalAddress { get; set; }
        public int LocalPort { get; set; }
        public uint OwningProcess { get; set; }
        public uint State { get; set; }
    }
    public static class TcpTable {
        [DllImport("iphlpapi.dll", SetLastError = false)]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size,
            [MarshalAs(UnmanagedType.Bool)] bool order, uint family, int tableClass, uint reserved);
        public static TcpOwner[] Read(int port, bool listenersOnly) {
            var result = new List<TcpOwner>();
            foreach (uint family in new uint[] { 2, 23 }) {
                uint size = 0;
                int tableClass = listenersOnly ? 3 : 5; // TCP_TABLE_OWNER_PID_LISTENER / ALL
                uint status = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, tableClass, 0);
                if (status != 0 && status != 122) throw new Win32Exception((int)status);
                bool complete = false;
                for (int attempt = 0; attempt < 5; attempt++) {
                    uint allocated = Math.Max(size, 4);
                    IntPtr buffer = Marshal.AllocHGlobal(checked((int)allocated));
                    try {
                        size = allocated;
                        status = GetExtendedTcpTable(buffer, ref size, false, family, tableClass, 0);
                        if (status == 122) continue; // the table grew between calls
                        if (status != 0) throw new Win32Exception((int)status);
                        uint count = unchecked((uint)Marshal.ReadInt32(buffer));
                        int stride = family == 2 ? 24 : 56;
                        if (4L + (long)count * stride > allocated) throw new InvalidOperationException("Invalid TCP table length");
                        for (int i = 0; i < count; i++) {
                            IntPtr row = IntPtr.Add(buffer, checked(4 + i * stride));
                            int portOffset = family == 2 ? 8 : 20;
                            int localPort = (Marshal.ReadByte(row, portOffset) << 8) | Marshal.ReadByte(row, portOffset + 1);
                            if (localPort != port) continue;
                            var address = new byte[family == 2 ? 4 : 16];
                            Marshal.Copy(IntPtr.Add(row, family == 2 ? 4 : 0), address, 0, address.Length);
                            uint state = unchecked((uint)Marshal.ReadInt32(row, family == 2 ? 0 : 48));
                            result.Add(new TcpOwner {
                                LocalAddress = family == 2 ? new IPAddress(address).ToString() :
                                    new IPAddress(address, unchecked((uint)Marshal.ReadInt32(row, 16))).ToString(),
                                LocalPort = localPort,
                                OwningProcess = unchecked((uint)Marshal.ReadInt32(row, family == 2 ? 20 : 52)),
                                State = state
                            });
                        }
                        complete = true;
                        break;
                    } finally { Marshal.FreeHGlobal(buffer); }
                }
                if (!complete) throw new InvalidOperationException("TCP table kept growing");
            }
            return result.ToArray();
        }
    }
}
namespace WeWe.LocalRelease {
  public static class IdentityTool {
    static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    public static int Main(string[] args) {
      Console.OutputEncoding = new System.Text.UTF8Encoding(false);
      try {
        Require(args.Length == 6, "Invalid identity arguments");
        string action = args[0];
        int pid = int.Parse(args[1], CultureInfo.InvariantCulture);
        int port = int.Parse(args[2], CultureInfo.InvariantCulture);
        Require(port >= 1 && port <= 65535, "Invalid port");
        Require(new[] { "Port", "Discover", "Snapshot", "Stop" }.Contains(action), "Invalid action");
        var json = new JavaScriptSerializer();
        var owners = TcpTable.Read(port, true);
        Require(owners.All(x => x.OwningProcess != 0), "TCP owner is unavailable");
        if (action == "Port") {
          Console.WriteLine(json.Serialize(owners.Select(x => new { x.LocalAddress, x.OwningProcess }).ToArray())); return 0;
        }
        if (action == "Discover") {
          if (owners.Length == 0) { Console.WriteLine("null"); return 0; }
          var pids = owners.Select(x => x.OwningProcess).Distinct().ToArray();
          Require(pids.Length == 1, "Port has multiple listener owners");
          pid = checked((int)pids[0]);
        }
        Require(pid > 0, "Invalid target PID");
        using (var process = Process.GetProcessById(pid)) {
          // Retain the same OS process handle through WMI/listener checks and Kill.
          var handle = process.Handle;
          DateTime start = process.StartTime.ToUniversalTime();
          string executable = null, command = null;
          using (var query = new ManagementObjectSearcher("SELECT CreationDate, ExecutablePath, CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
          using (var rows = query.Get()) {
            foreach (ManagementObject row in rows) {
              using (row) {
                DateTime created = ManagementDateTimeConverter.ToDateTime((string)row["CreationDate"]).ToUniversalTime();
                Require(Math.Abs((created - start).TotalSeconds) <= 1, "Process handle/WMI creation time mismatch");
                executable = (string)row["ExecutablePath"];
                command = (string)row["CommandLine"];
              }
            }
          }
          Require(!String.IsNullOrEmpty(executable) && !String.IsNullOrEmpty(command), "Process identity is unavailable");
          owners = TcpTable.Read(port, true);
          Require(owners.Length > 0 && owners.All(x => x.OwningProcess == pid), "Port is not exclusively owned by target PID");
          Require(!process.HasExited, "Process already exited");
          var identity = new System.Collections.Generic.Dictionary<string, object> {
            { "pid", pid }, { "startUtc", start.ToString("o") }, { "executable", executable },
            { "commandLine", command }, { "port", port },
            { "localAddresses", owners.Select(x => x.LocalAddress).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToArray() }
          };
          if (action == "Stop") {
            Require(args.Skip(3).All(x => !String.IsNullOrEmpty(x)), "Stop requires the full expected identity");
            Require(start.ToString("o") == args[3] && String.Equals(executable, args[4], StringComparison.OrdinalIgnoreCase) && command == args[5], "Process identity changed; stop refused");
            process.Kill();
            Require(process.WaitForExit(15000), "Process did not exit in 15 seconds");
            identity["stopped"] = true;
          }
          Console.WriteLine(json.Serialize(identity)); return 0;
        }
      } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
  }
}
