; Query Schema Agent — Windows installer (Inno Setup 6).
;
; Why this exists: the agent used to ship as a bare .exe. Whatever folder the
; browser dropped it in WAS the installation, so deleting the download removed
; the program, and nothing restarted it after a reboot. This installer makes it
; behave like any normal desktop app: it lives in its own folder, appears in
; Start and in Installed apps, starts with Windows, and uninstalls cleanly.
;
; Per-user install (PrivilegesRequired=lowest) — no UAC prompt, exactly how
; Chrome installs itself. {autopf} therefore resolves to
; %LOCALAPPDATA%\Programs.
;
; Build:  iscc installer\QuerySchemaAgent.iss     (run from agent\)
; Output: dist\QuerySchemaAgentSetup.exe

#define AppName        "Query Schema Agent"
#define AppVersion     "1.6.0"
#define AppPublisher   "Query Schema"
#define AppURL         "https://queryschema.com"
#define AppExe         "QuerySchemaAgent.exe"

[Setup]
; Never reuse this GUID for another product — it is the upgrade/uninstall identity.
AppId={{8F3C1A42-6B77-4E1D-9D2A-5C7E0B9A41D6}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}/download
DefaultDirName={autopf}\Query Schema Agent
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=QuerySchemaAgentSetup
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
; Let Restart Manager close the agent on upgrade instead of failing on a
; locked file. The [Code] section below is the belt-and-braces fallback.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startupicon"; Description: "Start {#AppName} when I sign in to Windows"; GroupDescription: "Startup"
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"; Flags: unchecked

[Files]
Source: "..\dist\agent-windows-amd64.exe"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startupicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent

[Code]
{ The agent holds a single-instance mutex. If an older copy is still running —
  typically the bare .exe the user left in Downloads — the freshly installed one
  would start, see the mutex and exit silently, looking broken. So close every
  known copy before installing and before uninstalling. }
procedure KillAgents();
var
  ResultCode: Integer;
  Names: array[0..4] of String;
  I: Integer;
begin
  Names[0] := 'QuerySchemaAgent.exe';
  Names[1] := 'agent.exe';
  Names[2] := 'agent-windows-amd64.exe';
  Names[3] := 'agent-windows-amd64-v6.exe';
  Names[4] := 'agent-windows-amd64-v5.exe';
  for I := 0 to 4 do
    Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM "' + Names[I] + '"',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  KillAgents();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    KillAgents();
end;
