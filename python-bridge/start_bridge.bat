@echo off
title Aethelgard MT5 Bridge
color 0A
echo.
echo  ================================================
echo   AETHELGARD MT5 BRIDGE v3 - AUTO START
echo  ================================================
echo.

REM Change to bridge directory
cd /d "%~dp0"

REM Check if MT5 is running, wait if not
echo [*] Waiting for MetaTrader 5 to start...
:WAIT_MT5
tasklist /FI "IMAGENAME eq terminal64.exe" 2>NUL | find /I /N "terminal64.exe" >NUL
if "%ERRORLEVEL%"=="1" (
    timeout /t 5 /nobreak >NUL
    goto WAIT_MT5
)
echo [+] MetaTrader 5 detected!
timeout /t 3 /nobreak >NUL

REM Start the bridge
echo [*] Starting Aethelgard bridge...
echo.
:RESTART
python bridge.py
echo.
echo [!] Bridge stopped. Restarting in 10 seconds...
timeout /t 10 /nobreak >NUL
goto RESTART
