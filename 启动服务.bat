@echo off
chcp 65001 >nul
title 语音播报系统

cd /d "%~dp0"

echo ================================================
echo   语音播报系统
echo   正在启动本地服务...
echo ================================================
echo.
echo   服务地址: http://127.0.0.1:5800
echo   音频目录: %cd%\audio
echo   按 Ctrl+C 停止服务
echo ================================================
echo.

py -m pip install -r requirements.txt -q 2>nul
py app.py

pause