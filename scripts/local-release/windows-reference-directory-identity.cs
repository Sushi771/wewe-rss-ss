// Read-only local directory identity, including extended Windows paths.
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class WeWeReferenceDirectoryProof {
    public string path;
    public string dev;
    public string ino;
    public string birthtimeNs;
}
public static class WeWeReferenceDirectoryIdentity {
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct Information {
        public uint Attributes;
        public FileTime Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string file, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out Information info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder value, uint capacity, uint flags);
    public static WeWeReferenceDirectoryProof Read(string file) {
        string full=System.IO.Path.GetFullPath(file);
        if (full.StartsWith(@"\\")) throw new InvalidOperationException("REFERENCE_NATIVE_REMOTE_DIRECTORY_UNSUPPORTED");
        using (SafeFileHandle handle=CreateFileW(@"\\?\"+full,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
            if (handle.IsInvalid) {
                int error=Marshal.GetLastWin32Error();
                if (error==2 || error==3) return null;
                throw new Win32Exception(error);
            }
            Information info;
            if (!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & 16)==0 || (info.Attributes & 1024)!=0) throw new InvalidOperationException("REFERENCE_NATIVE_SHORTCUT_DIRECTORY_INVALID");
            StringBuilder target=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandleW(handle,target,(uint)target.Capacity,0);
            if (length==0 || length>=target.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
            string canonical=target.ToString();
            if (!canonical.StartsWith(@"\\?\") || canonical.StartsWith(@"\\?\UNC\")) throw new InvalidOperationException("REFERENCE_NATIVE_REMOTE_DIRECTORY_UNSUPPORTED");
            if (!String.Equals(full.TrimEnd('\\'),canonical.Substring(4).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("REFERENCE_NATIVE_SHORTCUT_ALIAS_REQUIRES_REVIEW");
            ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;
            long birth=checked((checked((long)(((ulong)info.Creation.High<<32)|info.Creation.Low))-116444736000000000L)*100L);
            return new WeWeReferenceDirectoryProof { path=canonical.Substring(4), dev=info.Volume.ToString(CultureInfo.InvariantCulture), ino=index.ToString(CultureInfo.InvariantCulture), birthtimeNs=birth.ToString(CultureInfo.InvariantCulture) };
        }
    }
}
