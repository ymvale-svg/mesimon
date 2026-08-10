@echo off
chcp 65001 >nul
title משימון — מערכת ניהול משימות ופרויקטים
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [שגיאה] Node.js אינו מותקן על המחשב הזה.
  echo.
  echo   יש להתקין אותו פעם אחת מהכתובת:  https://nodejs.org
  echo   בוחרים את הגרסה הירוקה משמאל ^(LTS^), מתקינים עם Next עד הסוף,
  echo   ואז מריצים את הקובץ הזה שוב.
  echo.
  pause
  exit /b 1
)

echo.
echo   מפעיל את משימון... הדפדפן ייפתח בעוד רגע.
echo.
echo   חשוב: אין לסגור את החלון הזה כל עוד עובדים במערכת.
echo.

rem פתיחת הדפדפן אחרי שהשרת הספיק לעלות
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:3000"

node server\index.js

echo.
echo   השרת נעצר. ניתן לסגור את החלון.
echo.
pause
