@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ========================================
echo      Bienvenue dans Lumi  :)
echo   ========================================
echo.
echo   Le navigateur va s'ouvrir tout seul.
echo   Laisse cette fenetre ouverte pendant
echo   que tu utilises Lumi.
echo.
echo   Pour arreter Lumi : ferme cette fenetre.
echo.
node server.js
pause
