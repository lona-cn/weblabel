param([string]$CommandLine, [string]$InputLine = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class T32Terminal {
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
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int Run(string command,string input) {
  IntPtr ir,iw,or,ow,pc;
  if (!CreatePipe(out ir,out iw,IntPtr.Zero,0) || !CreatePipe(out or,out ow,IntPtr.Zero,0)) throw new Exception("CreatePipe failed");
  int hr=CreatePseudoConsole(new COORD{X=2000,Y=60},ir,ow,0,out pc);
  if(hr!=0) throw new Exception("CreatePseudoConsole: "+hr);
  CloseHandle(ir); CloseHandle(ow);
  IntPtr size=IntPtr.Zero;
  InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
  IntPtr attrs=Marshal.AllocHGlobal(size);
  PI pi=new PI();
  using(var output=new FileStream(new SafeFileHandle(or,true),FileAccess.Read))
  using(var writer=new FileStream(new SafeFileHandle(iw,true),FileAccess.Write)) {
   var text=new StringBuilder(); bool answered=false;
   var reader=Task.Run(()=> { byte[] b=new byte[8192]; int n; while((n=output.Read(b,0,b.Length))>0) { string s=Encoding.UTF8.GetString(b,0,n); lock(text) { text.Append(s); Console.Write(s); if(!answered && text.ToString().Contains("Type AUTHORIZE T32 GENERATED")) { answered=true; var bytes=Encoding.UTF8.GetBytes(input+"\r"); writer.Write(bytes,0,bytes.Length); writer.Flush(); } } } });
   try {
    if(!InitializeProcThreadAttributeList(attrs,1,0,ref size) || !UpdateProcThreadAttribute(attrs,0,new IntPtr(0x00020016),pc,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Exception("attribute failed");
    SIX si=new SIX{si=new SI{cb=Marshal.SizeOf(typeof(SIX)),flags=0x100},attributes=attrs};
    if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x00080400,IntPtr.Zero,Environment.CurrentDirectory,ref si,out pi)) throw new Exception("CreateProcess: "+Marshal.GetLastWin32Error());
    if(WaitForSingleObject(pi.process,60000)!=0) { TerminateProcess(pi.process,124); throw new Exception("PTY child timed out"); }
    uint code; GetExitCodeProcess(pi.process,out code);
    ClosePseudoConsole(pc); pc=IntPtr.Zero;
    reader.Wait(10000);
    return (int)code;
   } finally { if(pc!=IntPtr.Zero) ClosePseudoConsole(pc); if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process); DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
  }
 }
}
'@
exit [T32Terminal]::Run($CommandLine, $InputLine)
