@echo off
rem dsh-hub's command line on Windows: with Node.js when it's installed, else with the Node inside the DeepSeek
rem Harness desktop app (which every computer running the app has).
setlocal DisableDelayedExpansion
where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0dsh-hub.js" %*
  exit /b %errorlevel%
)
set "DSH_APP=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not exist "%DSH_APP%" (
  echo dsh-hub needs Node.js 22.13 or later, or the DeepSeek Harness app.
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%DSH_APP%" "%~dp0dsh-hub.js" %*
exit /b %errorlevel%
