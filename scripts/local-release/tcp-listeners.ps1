# Windows IP Helper API: use the owner-PID listener table, not localized text or CIM state.
# https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable
if (-not ('WeWe.LocalRelease.TcpTable' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
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
'@
}

function Get-LocalTcpListener {
    param([Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port)
    foreach ($row in [WeWe.LocalRelease.TcpTable]::Read($Port, $true)) {
        # This host returns inconsistent raw states for actual listeners (0/2/6).
        # TCP_TABLE_OWNER_PID_LISTENER asks Windows to select listeners itself.
        # Its documented membership, port and owner PID provide the listener
        # check; never infer listening from a raw-state row in the ALL table.
        if ($row.OwningProcess -eq 0) { throw 'TCP listener owner PID is unavailable' }
        $row
    }
}
