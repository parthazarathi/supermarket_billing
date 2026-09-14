; MartPOS SERVER-MODE installer - Inno Setup script (LEGACY)
; This packages the pkg-built console exe that serves MartPOS in a browser.
; The primary product is the Electron desktop app - build it with
;   npm run build            (electron-builder: NSIS setup + portable exe)
; Build this legacy installer with:
;   npm run build:server-installer

#define AppName "MartPOS Server"
#define AppVersion "1.0.0"
#define AppPublisher "MartPOS"
#define AppExe "MartPOS-Server.exe"

[Setup]
AppId={{B4E58D3F-1C2A-4F6B-9D7E-3F8A0B2C4D5E}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppComments=Supermarket billing, inventory and POS (server/browser mode)
DefaultDirName={autopf}\MartPOS-Server
DefaultGroupName=MartPOS Server
; Per-user install under %LOCALAPPDATA%\Programs - no admin rights required
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=dist
OutputBaseFilename=MartPOS-Server-Setup-{#AppVersion}
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
