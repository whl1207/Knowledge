@echo off
chcp 65001 >nul
rem ============================================================
rem One-click Linux packaging (x64: deb + AppImage; arm64: deb)
rem   Usage: scripts\build-linux-all.cmd [--skip-install]
rem   --skip-install : skip npm install when deps are unchanged
rem   （本脚本位于 <项目>\scripts\；项目根目录由脚本位置自动推导）
rem ============================================================
setlocal

rem 项目根目录 = 本脚本所在目录（<项目>\scripts\）的上一级
rem 例：D:\Project\1 Knowledge local\scripts\  ->  D:\Project\1 Knowledge local\
for %%I in ("%~dp0..") do set "ROOT=%%~fI\"

rem Convert d:\Project\1 Knowledge local\  ->  /mnt/d/Project/1 Knowledge local/
set "DRIVE=%ROOT:~0,1%"
set "REST=%ROOT:~3%"
set "REST=%REST:\=/%"

rem Lowercase the drive letter (WSL mount is /mnt/d)
for %%D in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do (
  if /i "%DRIVE%"=="%%D" set "DRIVE=%%D"
)

set "WSL_SCRIPT=/mnt/%DRIVE%/%REST%scripts/build-linux-all.sh"

echo Running one-click packaging in WSL (Ubuntu)...
echo Script: %WSL_SCRIPT%  Args: %*
echo -------------------------------------------------------
wsl -d Ubuntu -u root -- bash "%WSL_SCRIPT%" %*
set "EXIT=%ERRORLEVEL%"
echo -------------------------------------------------------
if "%EXIT%"=="0" (
  echo Done. Artifacts copied to %ROOT%release
) else (
  echo Packaging failed, exit code %EXIT% (see log above)
)
endlocal & exit /b %EXIT%
