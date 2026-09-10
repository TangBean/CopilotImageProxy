using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class JobHost
{
    private const uint CREATE_SUSPENDED = 0x4, CREATE_NEW_PROCESS_GROUP = 0x200;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    private const uint SYNCHRONIZE = 0x100000, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, INFINITE = 0xffffffff;
    private static IntPtr job = IntPtr.Zero;
    private static uint childPid, parentPid;
    private static int hostPid;
    private static long hostStartTimeUtcTicks;
    private static string pipeName, token;
    private static readonly ManualResetEvent stopRequested = new ManualResetEvent(false);
    private static volatile bool closing;
    private static NamedPipeServerStream currentPipe;
    private static readonly object pipeLock = new object();
    private static HandlerRoutine consoleHandler;

    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS
    { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct EXTENDED_LIMIT_INFORMATION
    {
        public BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX
    { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION
    { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES
    { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    private delegate bool HandlerRoutine(uint control);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr handle, int infoClass, ref EXTENDED_LIMIT_INFORMATION info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr handle, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr handle, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateFileW(string path, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GenerateConsoleCtrlEvent(uint control, uint processGroup);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);
    [DllImport("iphlpapi.dll", SetLastError = true)] private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

    private static void Check(bool success, string operation)
    { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }

    private static bool GoodHandle(IntPtr handle)
    { return handle != IntPtr.Zero && handle != new IntPtr(-1); }

    private static IntPtr InheritableStandardHandle(int which)
    {
        IntPtr source = GetStdHandle(which), duplicate;
        if (GoodHandle(source) && DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out duplicate, 0, true, 2)) return duplicate;
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); attributes.bInheritHandle = true;
        IntPtr fallback = CreateFileW("NUL", which == -10 ? 0x80000000u : 0x40000000u, 3, ref attributes, 3, 0, IntPtr.Zero);
        Check(GoodHandle(fallback), "open standard stream"); return fallback;
    }

    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
            else result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static PROCESS_INFORMATION Launch(string node, string entry)
    {
        IntPtr attributes = IntPtr.Zero, handlesMemory = IntPtr.Zero, environment = IntPtr.Zero;
        IntPtr[] inherited = new IntPtr[3]; bool initialized = false;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        try
        {
            for (int i = 0; i < 3; i++) inherited[i] = InheritableStandardHandle(-10 - i);
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "initialize child handle list"); initialized = true;
            handlesMemory = Marshal.AllocHGlobal(IntPtr.Size * inherited.Length);
            for (int i = 0; i < inherited.Length; i++) Marshal.WriteIntPtr(handlesMemory, i * IntPtr.Size, inherited[i]);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handlesMemory, new IntPtr(IntPtr.Size * inherited.Length), IntPtr.Zero, IntPtr.Zero), "set child handle list");
            SortedDictionary<string, string> variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry pair in Environment.GetEnvironmentVariables()) variables[(string)pair.Key] = (string)pair.Value;
            variables["CIP_JOB_HOST_PID"] = hostPid.ToString();
            StringBuilder block = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in variables) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            block.Append('\0'); environment = Marshal.StringToHGlobalUni(block.ToString());
            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = 0x100;
            startup.StartupInfo.hStdInput = inherited[0]; startup.StartupInfo.hStdOutput = inherited[1]; startup.StartupInfo.hStdError = inherited[2];
            startup.lpAttributeList = attributes;
            Check(CreateProcessW(node, new StringBuilder(Quote(node) + " " + Quote(entry)), IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environment, null, ref startup, out child), "create managed process");
            Check(AssignProcessToJobObject(job, child.hProcess), "assign managed process to job");
            if (ResumeThread(child.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "resume managed process");
            CloseHandle(child.hThread); child.hThread = IntPtr.Zero;
            return child;
        }
        catch
        {
            if (GoodHandle(child.hProcess)) { TerminateProcess(child.hProcess, 1); WaitForSingleObject(child.hProcess, 5000); CloseHandle(child.hProcess); }
            if (GoodHandle(child.hThread)) CloseHandle(child.hThread);
            throw;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handlesMemory != IntPtr.Zero) Marshal.FreeHGlobal(handlesMemory);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            foreach (IntPtr handle in inherited) if (GoodHandle(handle)) CloseHandle(handle);
        }
    }

    private static List<uint> ListeningOwners(int port)
    {
        SortedSet<uint> owners = new SortedSet<uint>();
        foreach (int family in new int[] { 2, 23 })
        {
            int size = 0; uint status = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0);
            if (status != 122 && status != 0) throw new Win32Exception((int)status, "read TCP owners");
            if (size == 0) continue;
            IntPtr memory = IntPtr.Zero;
            try
            {
                for (int attempt = 0; attempt < 4; attempt++)
                {
                    if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
                    memory = Marshal.AllocHGlobal(size);
                    status = GetExtendedTcpTable(memory, ref size, false, family, 3, 0);
                    if (status != 122) break;
                }
                if (status != 0) throw new Win32Exception((int)status, "read TCP owners");
                int count = Marshal.ReadInt32(memory), stride = family == 2 ? 24 : 56;
                if (count < 0 || (long)count * stride + 4 > size) throw new InvalidDataException();
                for (int i = 0; i < count; i++)
                {
                    int offset = 4 + i * stride, portOffset = offset + (family == 2 ? 8 : 20);
                    int localPort = (Marshal.ReadByte(memory, portOffset) << 8) | Marshal.ReadByte(memory, portOffset + 1);
                    if (localPort == port) owners.Add(unchecked((uint)Marshal.ReadInt32(memory, offset + (family == 2 ? 20 : 52))));
                }
            }
            finally { if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory); }
        }
        return new List<uint>(owners);
    }

    private static string OwnsPort(int port)
    {
        List<uint> owners = ListeningOwners(port); bool allOwned = owners.Count > 0;
        foreach (uint pid in owners)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            try
            {
                bool member;
                if (!GoodHandle(process) || !IsProcessInJob(process, job, out member) || !member) allOwned = false;
            }
            finally { if (GoodHandle(process)) CloseHandle(process); }
        }
        string[] ids = owners.ConvertAll<string>(delegate(uint pid) { return pid.ToString(); }).ToArray();
        return "{\"ok\":true,\"owned\":" + (allOwned ? "true" : "false") + ",\"pids\":[" + String.Join(",", ids) + "]}";
    }

    private static string ReadCommand(NamedPipeServerStream pipe)
    {
        Stopwatch deadline = Stopwatch.StartNew(); StringBuilder line = new StringBuilder(); byte[] buffer = new byte[1];
        while (line.Length < 512)
        {
            int remaining = 2000 - (int)deadline.ElapsedMilliseconds;
            if (remaining <= 0) return null;
            var pending = pipe.ReadAsync(buffer, 0, 1);
            if (!pending.Wait(remaining) || pending.Result == 0) return null;
            if (buffer[0] == 10) return line.ToString().TrimEnd('\r');
            if (buffer[0] < 32 || buffer[0] > 126) { if (buffer[0] != 13) return null; }
            line.Append((char)buffer[0]);
        }
        return null;
    }

    private static NamedPipeServerStream NewPipe()
    {
        PipeSecurity security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security);
    }

    private static void ServePipe(NamedPipeServerStream first)
    {
        NamedPipeServerStream pipe = first;
        while (!closing)
        {
            try
            {
                lock (pipeLock) { if (closing) { pipe.Dispose(); return; } currentPipe = pipe; }
                pipe.WaitForConnection();
                string command = ReadCommand(pipe); string result = "{\"ok\":false,\"error\":\"invalid_command\"}"; bool stop = false;
                if (command != null)
                {
                    string[] parts = command.Split(' ');
                    if (parts.Length >= 2 && String.Equals(parts[1], token, StringComparison.Ordinal))
                    {
                        if (parts.Length == 2 && parts[0] == "ping") result = "{\"ok\":true,\"pid\":" + hostPid + ",\"childPid\":" + childPid + ",\"parentPid\":" + parentPid + ",\"startTimeUtcTicks\":\"" + hostStartTimeUtcTicks + "\"}";
                        else if (parts.Length == 2 && parts[0] == "stop") { result = "{\"ok\":true}"; stop = true; }
                        else if (parts.Length == 3 && parts[0] == "owns-port")
                        {
                            int port;
                            if (Int32.TryParse(parts[2], out port) && port > 0 && port < 65536)
                            {
                                try { result = OwnsPort(port); }
                                catch { result = "{\"ok\":false,\"error\":\"port_query_failed\"}"; }
                            }
                        }
                    }
                }
                byte[] response = Encoding.UTF8.GetBytes(result + "\n"); pipe.Write(response, 0, response.Length); pipe.Flush();
                if (stop) stopRequested.Set();
            }
            catch { if (closing) return; }
            finally { pipe.Dispose(); lock (pipeLock) { if (Object.ReferenceEquals(currentPipe, pipe)) currentPipe = null; } }
            if (!closing)
            {
                try { pipe = NewPipe(); }
                catch { stopRequested.Set(); return; }
            }
        }
    }

    public static int Main(string[] args)
    {
        IntPtr parent = IntPtr.Zero; PROCESS_INFORMATION child = new PROCESS_INFORMATION(); NamedPipeServerStream initialPipe = null;
        try
        {
            using (Process self = Process.GetCurrentProcess()) { hostPid = self.Id; hostStartTimeUtcTicks = self.StartTime.ToUniversalTime().Ticks; }
            if (args.Length != 6 || args[0] != "--parent-pid" || args[2] != "--node" || args[4] != "--entry") throw new ArgumentException();
            if (!UInt32.TryParse(args[1], out parentPid) || parentPid == 0 || !Path.IsPathRooted(args[3]) || !Path.IsPathRooted(args[5]) || !File.Exists(args[3]) || !File.Exists(args[5])) throw new ArgumentException();
            pipeName = Environment.GetEnvironmentVariable("CIP_JOB_PIPE"); token = Environment.GetEnvironmentVariable("CIP_JOB_TOKEN");
            if (String.IsNullOrEmpty(pipeName) || pipeName.Length > 100 || String.IsNullOrEmpty(token) || token.Length > 200) throw new ArgumentException();
            foreach (char c in pipeName) if (!Char.IsLetterOrDigit(c) && c != '-' && c != '_') throw new ArgumentException();
            foreach (char c in token) if (c <= 32 || c > 126) throw new ArgumentException();
            parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, parentPid); Check(GoodHandle(parent), "open parent process");
            long parentCreation, parentExit, parentKernel, parentUser;
            Check(GetProcessTimes(parent, out parentCreation, out parentExit, out parentKernel, out parentUser), "read parent identity");
            if (DateTime.FromFileTimeUtc(parentCreation).Ticks > hostStartTimeUtcTicks) throw new InvalidOperationException();
            if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) throw new InvalidOperationException();
            job = CreateJobObjectW(IntPtr.Zero, null); Check(GoodHandle(job), "create job");
            EXTENDED_LIMIT_INFORMATION limits = new EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(EXTENDED_LIMIT_INFORMATION))), "configure job");
            initialPipe = NewPipe();
            child = Launch(args[3], args[5]); childPid = child.dwProcessId;
            NamedPipeServerStream pipeForThread = initialPipe; initialPipe = null;
            Thread pipeThread = new Thread(delegate() { ServePipe(pipeForThread); }); pipeThread.IsBackground = true; pipeThread.Start();
            consoleHandler = delegate(uint control) { if (control == 0 || control == 1) { stopRequested.Set(); return true; } return false; };
            SetConsoleCtrlHandler(consoleHandler, true);
            IntPtr[] waits = new IntPtr[] { child.hProcess, parent, stopRequested.SafeWaitHandle.DangerousGetHandle() };
            uint cause = WaitForMultipleObjects((uint)waits.Length, waits, false, INFINITE);
            if (cause == WAIT_OBJECT_0)
            {
                uint code; Check(GetExitCodeProcess(child.hProcess, out code), "read child exit code"); return unchecked((int)code);
            }
            if (cause == WAIT_OBJECT_0 + 2)
            {
                if (GenerateConsoleCtrlEvent(1, child.dwProcessId)) WaitForSingleObject(child.hProcess, 5000);
                return 0;
            }
            if (cause == WAIT_OBJECT_0 + 1) return 1;
            throw new Win32Exception(Marshal.GetLastWin32Error(), "wait for lifecycle event");
        }
        catch (Win32Exception error) { Console.Error.WriteLine("JobHost: Windows lifecycle operation failed (code " + error.NativeErrorCode + ")."); return 1; }
        catch { Console.Error.WriteLine("JobHost: invalid startup or lifecycle failure."); return 1; }
        finally
        {
            closing = true;
            lock (pipeLock) { if (currentPipe != null) currentPipe.Dispose(); }
            if (initialPipe != null) initialPipe.Dispose();
            if (GoodHandle(job)) { TerminateJobObject(job, 1); CloseHandle(job); job = IntPtr.Zero; }
            if (GoodHandle(child.hProcess)) { WaitForSingleObject(child.hProcess, 5000); CloseHandle(child.hProcess); }
            if (GoodHandle(parent)) CloseHandle(parent);
            GC.KeepAlive(consoleHandler);
        }
    }
}
