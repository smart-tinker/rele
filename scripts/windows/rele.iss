#ifndef StageDir
  #error StageDir must name the complete Windows package.
#endif

[Setup]
AppId={{3F09F239-2927-4ED8-9431-A74CCED1D5EB}
AppName=Rele
AppVersion={#AppVersion}
VersionInfoVersion={#NativeVersion}
AppPublisher=Rele
AppPublisherURL=https://github.com/smart-tinker/rele
DefaultDirName={localappdata}\Programs\Rele
DefaultGroupName=Rele
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UsePreviousAppDir=yes
UninstallDisplayIcon={app}\Rele.exe
UninstallDisplayName=Rele
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
OutputDir={#OutputDir}
OutputBaseFilename=rele-{#AppVersion}-windows-x64-setup

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[CustomMessages]
english.OpenRele=Open Rele
english.RestartRele=Restart Rele
english.StopRele=Stop Rele
english.SharedDesktop=Codex Desktop (shared with Rele)
english.SharedCli=Codex CLI (shared with Rele)
english.IntegrateDesktop=Connect ordinary Codex Desktop launches to the shared Codex backend
english.DesktopNotice=After enabling Desktop integration, fully quit Codex Desktop once, then open it again. Existing tasks are not stopped by this installer.
english.DesktopSkipped=Codex Desktop integration was skipped:
english.DataPreserved=Rele's settings, chat bindings, and backups remain in the data directory when the program is uninstalled.
russian.OpenRele=Открыть Rele
russian.RestartRele=Перезапустить Rele
russian.StopRele=Остановить Rele
russian.SharedDesktop=Codex Desktop (общий с Rele)
russian.SharedCli=Codex CLI (общий с Rele)
russian.IntegrateDesktop=Подключить обычный запуск Codex Desktop к общему Codex
russian.DesktopNotice=После подключения полностью закройте Codex Desktop один раз и откройте снова. Установщик не останавливает его текущие задачи.
russian.DesktopSkipped=Подключение Codex Desktop пропущено:
russian.DataPreserved=При удалении программы настройки, связки чатов и резервные копии останутся в каталоге данных.

[Tasks]
; Fresh installs enable this task; UsePreviousTasks=yes preserves an explicit prior choice.
Name: "desktop"; Description: "{cm:IntegrateDesktop}"

[Files]
Source: "{#StageDir}\Rele.exe"; Flags: dontcopy
Source: "{#StageDir}\*"; DestDir: "{app}"; Excludes: "start-codex.cmd,start-codex.sh,start-rele.cmd,start-rele.sh,install-autostart.cmd,install-user-service.sh,scripts\install-autostart.mjs,scripts\install-user-service.mjs"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{cm:OpenRele}"; Filename: "{app}\Rele.exe"; Parameters: "open"; WorkingDir: "{app}"
Name: "{group}\{cm:RestartRele}"; Filename: "{app}\Rele.exe"; Parameters: "restart"; WorkingDir: "{app}"
Name: "{group}\{cm:StopRele}"; Filename: "{app}\Rele.exe"; Parameters: "stop"; WorkingDir: "{app}"
Name: "{group}\{cm:SharedDesktop}"; Filename: "{app}\Rele.exe"; Parameters: "codex-desktop"; WorkingDir: "{app}"
Name: "{group}\{cm:SharedCli}"; Filename: "{code:SharedCodexPath}"; Parameters: "--rele-cli"; WorkingDir: "{code:SharedCodexDirectory}"

[Run]
Filename: "{app}\Rele.exe"; Parameters: "open"; Description: "{cm:OpenRele}"; Flags: nowait postinstall skipifsilent; Check: CanOpenRele

[UninstallDelete]
Type: files; Name: "{app}\rele-install.json"

[Code]
var
  HadRuntime: Boolean;
  Prepared: Boolean;
  Installed: Boolean;
  InstallFailed: Boolean;
  InstallDataDir: String;
  InstallTaskName: String;
  InstallPort: String;
  InstallCodexHome: String;
  SharedCodexExecutable: String;

function Quoted(Value: String): String;
var
  I: Integer;
begin
  if Pos('"', Value) > 0 then
    RaiseException('Invalid quotation mark in a Rele installation argument.');
  Result := '"' + Value;
  { Windows argv parsing doubles a trailing backslash before the closing quote. }
  I := Length(Value);
  while (I > 0) and (Value[I] = '\') do
  begin
    Result := Result + '\';
    I := I - 1;
  end;
  Result := Result + '"';
end;

function ParameterOrPrevious(Name, DefaultValue: String): String;
begin
  Result := ExpandConstant('{param:' + Name + '|}');
  if Result = '' then Result := GetPreviousData(Name, DefaultValue);
end;

procedure InitializeWizard;
begin
  InstallDataDir := ParameterOrPrevious('RELEDATADIR', ExpandConstant('{localappdata}\Rele'));
  InstallTaskName := ParameterOrPrevious('RELETASKNAME', '');
  InstallPort := ParameterOrPrevious('RELEPORT', '3210');
  InstallCodexHome := ParameterOrPrevious('RELECODEXHOME', '');
  WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + CustomMessage('DataPreserved');
end;

function SettingsArguments: String;
begin
  Result := ' --app-dir ' + Quoted(ExpandConstant('{app}')) +
    ' --data-dir ' + Quoted(InstallDataDir) + ' --port ' + Quoted(InstallPort);
  if InstallTaskName <> '' then Result := Result + ' --task-name ' + Quoted(InstallTaskName);
  if InstallCodexHome <> '' then Result := Result + ' --codex-home ' + Quoted(InstallCodexHome);
end;

function RunLauncher(Filename, Arguments: String): String;
var
  ExitCode: Integer;
  ErrorFile: String;
  ErrorLines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  ErrorFile := ExpandConstant('{tmp}\rele-installer-error.txt');
  DeleteFile(ErrorFile);
  if not Exec(Filename, Arguments + ' --quiet --error-file ' + Quoted(ErrorFile),
    ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
  begin
    Result := 'Cannot run Rele: ' + SysErrorMessage(ExitCode);
    Exit;
  end;
  if ExitCode = 0 then Exit;
  if LoadStringsFromFile(ErrorFile, ErrorLines) then
    for I := 0 to GetArrayLength(ErrorLines) - 1 do Result := Result + ErrorLines[I] + #13#10;
  if Result = '' then Result := 'Rele could not complete the operation. Exit code: ' + IntToStr(ExitCode);
  Log(Result);
end;

function SharedCodexPath(Param: String): String;
var
  PathFile: String;
  ErrorText: String;
  PathText: AnsiString;
begin
  if SharedCodexExecutable <> '' then
  begin
    Result := SharedCodexExecutable;
    Exit;
  end;
  PathFile := ExpandConstant('{tmp}\rele-codex-path.txt');
  DeleteFile(PathFile);
  ErrorText := RunLauncher(ExpandConstant('{app}\Rele.exe'), 'adapter-path' + SettingsArguments + ' --path-file ' + Quoted(PathFile));
  if ErrorText <> '' then RaiseException(ErrorText);
  if not LoadStringFromFile(PathFile, PathText) then RaiseException('Cannot read the shared Codex adapter path.');
  Result := UTF8Decode(PathText);
  if not FileExists(Result) then RaiseException('The shared Codex adapter is missing.');
  SharedCodexExecutable := Result;
end;

function SharedCodexDirectory(Param: String): String;
begin
  Result := ExtractFileDir(SharedCodexPath(Param));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  HadRuntime := FileExists(ExpandConstant('{app}\dist\server\main.js'));
  ExtractTemporaryFile('Rele.exe');
  Result := RunLauncher(ExpandConstant('{tmp}\Rele.exe'), 'prepare-update' + SettingsArguments);
  Prepared := Result = '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Arguments: String;
  ErrorText: String;
  WarningFile: String;
  WarningText: AnsiString;
begin
  if CurStep = ssPostInstall then
  begin
    Arguments := 'install' + SettingsArguments;
    WarningFile := ExpandConstant('{tmp}\rele-desktop-warning.txt');
    DeleteFile(WarningFile);
    if WizardIsTaskSelected('desktop') then
      Arguments := Arguments + ' --desktop-integration --warning-file ' + Quoted(WarningFile);
    if not HadRuntime then Arguments := Arguments + ' --backup';
    ErrorText := RunLauncher(ExpandConstant('{app}\Rele.exe'), Arguments);
    if ErrorText <> '' then
    begin
      InstallFailed := True;
      RaiseException(ErrorText);
    end;
    Installed := True;
    if LoadStringFromFile(WarningFile, WarningText) then
    begin
      Log(CustomMessage('DesktopSkipped') + ' ' + UTF8Decode(WarningText));
      WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + CustomMessage('DesktopSkipped') + ' ' + UTF8Decode(WarningText);
    end
    else if WizardIsTaskSelected('desktop') then
      WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + CustomMessage('DesktopNotice');
  end;
end;

function CanOpenRele: Boolean;
begin
  Result := Installed and not InstallFailed;
end;

function GetCustomSetupExitCode: Integer;
begin
  if InstallFailed then Result := 1 else Result := 0;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'RELEDATADIR', InstallDataDir);
  SetPreviousData(PreviousDataKey, 'RELETASKNAME', InstallTaskName);
  SetPreviousData(PreviousDataKey, 'RELEPORT', InstallPort);
  SetPreviousData(PreviousDataKey, 'RELECODEXHOME', InstallCodexHome);
end;

procedure DeinitializeSetup;
begin
  { If copying was cancelled after a successful stop, make the prior task usable again. }
  if Prepared and not Installed and HadRuntime and FileExists(ExpandConstant('{app}\Rele.exe')) then
    RunLauncher(ExpandConstant('{app}\Rele.exe'), 'start');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ErrorText: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    ErrorText := RunLauncher(ExpandConstant('{app}\Rele.exe'), 'uninstall');
    if ErrorText <> '' then
    begin
      if not UninstallSilent then MsgBox(ErrorText, mbError, MB_OK);
      Abort;
    end;
  end;
end;
