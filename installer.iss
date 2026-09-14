; MartPOS installer - Inno Setup script
; Build: npm run build:installer  (produces dist\MartPOS-Setup-<version>.exe)

#define AppName "MartPOS"
#define AppVersion "1.0.0"
#define AppPublisher "MartPOS"
#define AppExe "MartPOS.exe"

[Setup]
AppId={{A3F47C2E-9B1D-4E5A-B6C8-2D7E9F0A1B3D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppComments=Supermarket billing, inventory and POS
DefaultDirName={autopf}\MartPOS
DefaultGroupName=MartPOS
; Per-user install under %LOCALAPPDATA%\Programs - no admin rights required
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=dist
OutputBaseFilename=MartPOS-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName} {#AppVersion}
UninstallDisplayIcon={app}\{#AppExe}
CloseApplications=force
; Shop data lives in %LOCALAPPDATA%\MartPOS (outside the install dir) and is
; never touched by install/uninstall/upgrade.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "Start Mart POS billing"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName} now"; Flags: postinstall nowait skipifsilent unchecked
