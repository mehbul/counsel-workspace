@echo off
rem Protocol stdout must remain clean. Node resolves relative to this script.
node "%~dp0server.mjs" %*
