$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.Runtime.InteropServices;
public class PathBoundary { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFileExW(string a,string b,uint flags); }
'@
$root=Join-Path $PSScriptRoot 'native-owned'
[System.IO.Directory]::CreateDirectory($root)|Out-Null
$source=Join-Path $root '.tmp-owned'
$dest=Join-Path $root ('d'*111)
[System.IO.File]::WriteAllText(('\\?\'+$source),'owned-native-path-probe')
$plain=[PathBoundary]::MoveFileExW($source,$dest,8); $plainError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
$extended=[PathBoundary]::MoveFileExW(('\\?\'+$source),('\\?\'+$dest),8); $extendedError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
@{source=$source;destination=$dest;source_length=$source.Length;destination_length=$dest.Length;plain_result=$plain;plain_error=$plainError;extended_result=$extended;extended_error=$extendedError;source_exists=[System.IO.File]::Exists(('\\?\'+$source));destination_exists=[System.IO.File]::Exists(('\\?\'+$dest))}|ConvertTo-Json
