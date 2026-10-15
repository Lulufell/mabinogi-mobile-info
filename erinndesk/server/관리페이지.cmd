@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
python admin_web.py
if errorlevel 1 (
  echo.
  echo Install dependencies: python -m pip install -r requirements-admin.txt
  pause
)
endlocal
