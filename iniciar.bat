@echo off
title Sistema de Reserva de Laboratorios
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    py -m pip install -r requirements.txt --quiet
    py app.py
) else (
    python -m pip install -r requirements.txt --quiet
    python app.py
)

pause
