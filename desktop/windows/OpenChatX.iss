#ifndef SourceDir
  #error SourceDir must be provided with /DSourceDir=<path>
#endif

#ifndef OutputDir
  #error OutputDir must be provided with /DOutputDir=<path>
#endif

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#ifndef TargetArch
  #define TargetArch "x64"
#endif

#ifndef AllowedArch
  #define AllowedArch "x64compatible"
#endif

#ifndef InstallArch
  #define InstallArch "x64compatible"
#endif

#ifndef IconFile
  #define IconFile "OpenChatX.ico"
#endif

[Setup]
AppId={{D42C71EF-37FA-4C46-99DE-4654B19D1BCE}
AppName=OpenChatX
AppVersion={#AppVersion}
AppPublisher=OpenChatX
DefaultDirName={localappdata}\Programs\OpenChatX
DefaultGroupName=OpenChatX
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed={#AllowedArch}
ArchitecturesInstallIn64BitMode={#InstallArch}
OutputDir={#OutputDir}
OutputBaseFilename=OpenChatX-Setup-{#TargetArch}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\OpenChatX.exe
SetupLogging=yes
SetupIconFile={#IconFile}

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\OpenChatX"; Filename: "{app}\OpenChatX.exe"
Name: "{userdesktop}\OpenChatX"; Filename: "{app}\OpenChatX.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Run]
Filename: "{app}\OpenChatX.exe"; Description: "Launch OpenChatX"; Flags: nowait postinstall skipifsilent
