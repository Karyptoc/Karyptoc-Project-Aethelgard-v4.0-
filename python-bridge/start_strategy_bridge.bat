@echo off
title Aethelgard STRATEGY Bridge (HFM)
cd /d "%~dp0"
echo Starting the strategy bridge (Strategies A/B on the HFM terminal)...
:RESTART
python strategy_bridge.py
echo Strategy bridge stopped. Restarting in 10 seconds...
timeout /t 10 /nobreak >NUL
goto RESTART
