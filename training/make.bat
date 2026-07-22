@echo off
setlocal EnableExtensions
rem GOSAI model training -- Windows wrapper, mirrors the Makefile targets.
rem
rem Usage (cmd):         make <target> [model]
rem Usage (PowerShell):  .\make <target> [model]
rem
rem   make setup
rem   make all
rem   make train ball
rem   set MODEL=ball && make train     (env var works too; arg wins)

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=help"

set "MODEL_NAME=%~2"
if "%MODEL_NAME%"=="" set "MODEL_NAME=%MODEL%"

if /i "%TARGET%"=="help" goto :help
if /i "%TARGET%"=="setup" goto :setup
if /i "%TARGET%"=="clean" goto :clean

set "MODEL_ARG="
if not "%MODEL_NAME%"=="" set "MODEL_ARG=--model %MODEL_NAME%"
uv run gosai-train %MODEL_ARG% %TARGET%
exit /b %errorlevel%

:help
echo Targets: setup ^| models ^| download ^| negatives ^| prepare ^| frames ^| autolabel ^| train ^| eval ^| mine ^| export ^| install ^| all ^| clean
echo Select a model with:  make ^<target^> ^<model^>   (default: ball)
exit /b 0

:setup
uv sync
exit /b %errorlevel%

:clean
if "%MODEL_NAME%"=="" set "MODEL_NAME=ball"
for %%d in (raw merged negatives_pool mining) do (
    if exist "models\%MODEL_NAME%\data\%%d" rmdir /s /q "models\%MODEL_NAME%\data\%%d"
)
if exist "models\%MODEL_NAME%\runs" rmdir /s /q "models\%MODEL_NAME%\runs"
if exist "models\%MODEL_NAME%\exports" rmdir /s /q "models\%MODEL_NAME%\exports"
exit /b 0
