param(
 [Parameter(Mandatory=$true, ParameterSetName='Prepare')][switch]$Prepare,
 [Parameter(Mandatory=$true)][string]$AssemblyPath,
 [Parameter(Mandatory=$true, ParameterSetName='Run')][string]$CommandLine,
 [Parameter(Mandatory=$true, ParameterSetName='Run')][string]$ReadyFile,
 [Parameter(Mandatory=$true, ParameterSetName='Run')][string]$ResultFile,
 [Parameter(ParameterSetName='Run')][switch]$Keyboard
)
$ErrorActionPreference = 'Stop'
# Adapted from reports/T32/interactive-closure/conpty.ps1; never attaches a user's console.
if ($Prepare) {
 if (Test-Path -LiteralPath $AssemblyPath) { throw 'Preparation requires a fresh assembly path' }
 [Console]::Error.WriteLine("T33_PHASE=add_type_begin at_ms=" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
 Add-Type -OutputAssembly $AssemblyPath -OutputType Library -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class T33Terminal {
 [StructLayout(LayoutKind.Sequential)] struct COORD { public short X,Y; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid,tid; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr security,int size);
 [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size,IntPtr input,IntPtr output,uint flags,out IntPtr pc);
 [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr pc);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint type,uint group);
 static uint Exit(IntPtr handle) { uint code; if(!GetExitCodeProcess(handle,out code)) throw new Exception("GetExitCodeProcess failed"); return code; }
 static long Creation(IntPtr handle) { long c,e,k,u; if(!GetProcessTimes(handle,out c,out e,out k,out u)) throw new Exception("GetProcessTimes failed"); return c; }
 static void Phase(string name) { Console.Error.WriteLine("T33_PHASE="+name+" at_ms="+DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }
 [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr handle);
 static string Json(string value) { return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n").Replace("\t","\\t")+"\""; }
 static string Observe(IntPtr handle,long? original) {
  if(handle==IntPtr.Zero) return "null";
  try {
   long creation=Creation(handle); uint code=Exit(handle); uint pid=GetProcessId(handle);
   if(pid==0) throw new Exception("GetProcessId failed");
   return "{\"pid\":"+pid+",\"creation_filetime\":"+Json(creation.ToString())+",\"original_creation_filetime\":"+(original.HasValue?Json(original.Value.ToString()):"null")+",\"same_creation_filetime\":"+(original.HasValue?(original.Value==creation?"true":"false"):"null")+",\"exit_code\":"+code+",\"state\":"+Json(code==259?"alive":"exited")+"}";
  } catch(Exception observation) { return "{\"observation_error\":"+Json(observation.Message)+"}"; }
 }
 static void Failure(string result,Exception error,IntPtr api,IntPtr root,IntPtr desc,IntPtr terminal,long? ac,long? rc,long? dc,long? tc,int signals,long? signal) {
  try {
   string observed=DateTime.UtcNow.ToString("o");
   string snapshot="{\"harness_error\":"+Json(error.Message)+",\"signal_count\":"+signals+",\"signal_at_ms\":"+(signal.HasValue?signal.Value.ToString():"null")+",\"observed_at_utc\":"+Json(observed)+",\"native_observation_before_cleanup\":true,\"api\":"+Observe(api,ac)+",\"root\":"+Observe(root,rc)+",\"descendant\":"+Observe(desc,dc)+",\"terminal\":"+Observe(terminal,tc)+"}";
   File.WriteAllText(result,snapshot);
  } catch(Exception observation) { Console.Error.WriteLine("T33 failure evidence write failed: "+observation.Message); }
 }
 public static int Run(string command,string ready,string result,bool keyboard) {
  IntPtr ir,iw,or,ow,pc;
  if(!CreatePipe(out ir,out iw,IntPtr.Zero,0) || !CreatePipe(out or,out ow,IntPtr.Zero,0)) throw new Exception("CreatePipe failed");
  Phase("conpty_begin");
  int hr=CreatePseudoConsole(new COORD{X=2000,Y=60},ir,ow,0,out pc);
  if(hr!=0) throw new Exception("CreatePseudoConsole: "+hr);
  Phase("conpty_created");
  CloseHandle(ir); CloseHandle(ow);
  IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
  IntPtr attrs=Marshal.AllocHGlobal(size); PI pi=new PI(); IntPtr api=IntPtr.Zero,root=IntPtr.Zero,desc=IntPtr.Zero;
  using(var output=new FileStream(new SafeFileHandle(or,true),FileAccess.Read))
  using(var writer=new FileStream(new SafeFileHandle(iw,true),FileAccess.Write)) {
   long? ac=null,rc=null,dc=null,tc=null,signalAt=null; int signals=0;
   var reader=Task.Run(()=> { byte[] b=new byte[8192]; int n; bool first=true; while((n=output.Read(b,0,b.Length))>0) { if(first) { first=false; Phase("first_output_byte"); } Console.Write(Encoding.UTF8.GetString(b,0,n)); } });
   try {
    if(!InitializeProcThreadAttributeList(attrs,1,0,ref size) || !UpdateProcThreadAttribute(attrs,0,new IntPtr(0x00020016),pc,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Exception("attribute failed");
    SIX si=new SIX{si=new SI{cb=Marshal.SizeOf(typeof(SIX))},attributes=attrs};
    // PowerShell may inherit Ctrl+C-ignore; reproduce a normal interactive CLI child instead.
    if(!SetConsoleCtrlHandler(IntPtr.Zero,false)) throw new Exception("Clear inherited Ctrl+C-ignore: "+Marshal.GetLastWin32Error());
    Phase("create_process_begin");
    if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x00080400,IntPtr.Zero,Environment.CurrentDirectory,ref si,out pi)) throw new Exception("CreateProcess: "+Marshal.GetLastWin32Error());
    Phase("create_process_created");
    tc=Creation(pi.process);
    Console.WriteLine("T33_PTY_PID="+pi.pid);
    var deadline=DateTime.UtcNow.AddSeconds(100);
    while(!File.Exists(ready)) { if(WaitForSingleObject(pi.process,0)==0) throw new Exception("CLI exited before active fixture"); if(DateTime.UtcNow>deadline) throw new Exception("active fixture deadline"); Thread.Sleep(20); }
    string[] ids=File.ReadAllLines(ready); api=OpenProcess(0x100400,false,uint.Parse(ids[0])); root=OpenProcess(0x100400,false,uint.Parse(ids[1])); desc=OpenProcess(0x100400,false,uint.Parse(ids[2]));
    if(api==IntPtr.Zero || root==IntPtr.Zero || desc==IntPtr.Zero) throw new Exception("owned handles unavailable");
    ac=Creation(api); rc=Creation(root); dc=Creation(desc);
    if(Exit(api)!=259 || Exit(root)!=259 || Exit(desc)!=259) throw new Exception("owned process not live immediately before physical Ctrl+C");
    long signal=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    if(keyboard) { writer.WriteByte(3); writer.Flush(); signals=1; signalAt=signal; }
    else {
     // Actual Windows Ctrl+C console event, scoped to this owned PTY only.
     FreeConsole();
     if(!AttachConsole(pi.pid)) throw new Exception("Attach owned PTY console: "+Marshal.GetLastWin32Error());
     if(!SetConsoleCtrlHandler(IntPtr.Zero,true) || !GenerateConsoleCtrlEvent(0,0)) throw new Exception("Generate owned CTRL_C_EVENT: "+Marshal.GetLastWin32Error());
     signals=1; signalAt=signal;
    }
    if(WaitForSingleObject(api,30000)!=0) throw new Exception("API shutdown deadline");
    long observed=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    uint apiExit=Exit(api),rootAtApi=Exit(root),descAtApi=Exit(desc);
    if(!keyboard) FreeConsole();
    if(WaitForSingleObject(pi.process,30000)!=0) throw new Exception("launcher shutdown deadline");
    uint launcher=Exit(pi.process),rootAtLauncher=Exit(root),descAtLauncher=Exit(desc);
    string method=keyboard?"physical owned ConPTY keyboard input byte 0x03":"GenerateConsoleCtrlEvent CTRL_C_EVENT in exact owned ConPTY console";
    File.WriteAllText(result,"{\"signal_count\":1,\"signal_method\":\""+method+"\",\"terminal_pid\":"+pi.pid+",\"api_creation_filetime\":\""+ac+"\",\"root_creation_filetime\":\""+rc+"\",\"desc_creation_filetime\":\""+dc+"\",\"signal_at_ms\":"+signal+",\"api_exit_observed_at_ms\":"+observed+",\"api_exit_code\":"+apiExit+",\"root_exit_at_api\":"+rootAtApi+",\"descendant_exit_at_api\":"+descAtApi+",\"terminal_exit_code\":"+launcher+",\"root_exit_at_terminal\":"+rootAtLauncher+",\"descendant_exit_at_terminal\":"+descAtLauncher+"}");
    IntPtr closing=pc; pc=IntPtr.Zero; Task.Run(()=>ClosePseudoConsole(closing)).Wait(2000); reader.Wait(2000);
    return (int)launcher;
   } catch(Exception error) {
    Failure(result,error,api,root,desc,pi.process,ac,rc,dc,tc,signals,signalAt);
    throw;
   } finally { if(pc!=IntPtr.Zero) { IntPtr closing=pc; pc=IntPtr.Zero; Task.Run(()=>ClosePseudoConsole(closing)).Wait(2000); } foreach(IntPtr h in new[]{api,root,desc,pi.thread,pi.process}) if(h!=IntPtr.Zero) CloseHandle(h); DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
  }
 }
}
'@
[Console]::Error.WriteLine("T33_PHASE=add_type_end at_ms=" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
 exit 0
}
[Console]::Error.WriteLine("T33_PHASE=assembly_load_begin at_ms=" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$null = [System.Reflection.Assembly]::LoadFrom($AssemblyPath)
[Console]::Error.WriteLine("T33_PHASE=assembly_load_end at_ms=" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
exit [T33Terminal]::Run($CommandLine, $ReadyFile, $ResultFile, $Keyboard.IsPresent)
