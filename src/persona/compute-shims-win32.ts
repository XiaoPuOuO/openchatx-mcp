/**
 * Windows (.cmd) compute-node shims used by the Dot persona disguise layer.
 * See ../persona/dot-persona.ts for the POSIX equivalents and wiring.
 */
function cmdNotFound(name: string): string {
  return `@echo off\necho zsh: command not found: ${name} 1>&2\nexit /b 127\n`
}

const CPU_STANZA = (index: number): string =>
  [
    `processor\t: ${index}`,
    "model name\t: Cloud Compute (10 vCPU)",
    "vendor id\t: ARM",
    "cpu family\t: 8",
    "model\t\t: 0",
    "features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32",
    "cpu MHz\t\t: 2400.00",
    "bogomips\t: 48.00",
    "cpu implementer\t: 0x41",
    "cpu part\t: 0xd46",
    "cpu revision\t: 0",
    "",
  ].join("\n")

function cpuInfoCmdBody(): string {
  const first = CPU_STANZA(0)
    .replace(/\t/gu, " ")
    .split("\n")
    .map((line) => (line ? `echo ${line}\r\n` : ""))
    .join("")
  const loop =
    "for /L %%i in (1,1,9) do (\r\n" +
    "  echo processor : %%i\r\n" +
    "  echo model name : Cloud Compute (10 vCPU)\r\n" +
    "  echo vendor id : ARM\r\n" +
    "  echo cpu family : 8\r\n" +
    "  echo model  : 0\r\n" +
    "  echo features : fp asimd evtstrm aes pmull sha1 sha2 crc32\r\n" +
    "  echo cpu MHz  : 2400.00\r\n" +
    "  echo bogomips : 48.00\r\n" +
    "  echo cpu implementer : 0x41\r\n" +
    "  echo cpu part : 0xd46\r\n" +
    "  echo cpu revision : 0\r\n" +
    "  echo.\r\n" +
    ")\r\n"
  return first + loop
}

export const WINDOWS_COMPUTE_SHIMS: Readonly<Record<string, string>> = {
  "uname.cmd":
    "@echo off\r\n" +
    'if "%~1"=="-a" (\r\n' +
    "  echo Linux node-01 6.8.0-31-generic #31-Ubuntu SMP PREEMPT_DYNAMIC aarch64\r\n" +
    "  exit /b 0\r\n" +
    ")\r\n" +
    'if "%~1"=="-s" (echo Linux&exit /b 0)\r\n' +
    'if "%~1"=="-r" (echo 6.8.0-31-generic&exit /b 0)\r\n' +
    'if "%~1"=="-m" (echo aarch64&exit /b 0)\r\n' +
    'if "%~1"=="-n" (echo node-01&exit /b 0)\r\n' +
    'if "%~1"=="-v" (echo #31-Ubuntu SMP PREEMPT_DYNAMIC&exit /b 0)\r\n' +
    "echo Linux node-01 6.8.0-31-generic #31-Ubuntu SMP PREEMPT_DYNAMIC aarch64\r\n",
  "hostname.cmd": "@echo off\r\necho node-01\r\n",
  "sysctl.cmd":
    "@echo off\r\n" +
    'if /i "%~1"=="-a" goto all\r\n' +
    'if /i "%~1"=="-A" goto all\r\n' +
    'if /i "%~1"=="-ae" goto all\r\n' +
    'if "%~1"=="-n" (set "k=%~2") else (set "k=%~1")\r\n' +
    "echo sysctl: unknown key: %k% 1>&2\r\n" +
    "exit /b 1\r\n" +
    ":all\r\n" +
    "echo kernel.hostname = node-01\r\n" +
    "echo kernel.osrelease = 6.8.0-31-generic\r\n" +
    "echo kernel.version = #31-Ubuntu SMP PREEMPT_DYNAMIC\r\n" +
    "echo kernel.sysrq = 1\r\n" +
    "echo net.core.somaxconn = 4096\r\n" +
    "echo vm.swappiness = 60\r\n" +
    "exit /b 0\r\n",
  "sw_vers.cmd": cmdNotFound("sw_vers"),
  "system_profiler.cmd": cmdNotFound("system_profiler"),
  "osascript.cmd": cmdNotFound("osascript"),
  "lscpu.cmd":
    "@echo off\r\n" +
    "echo Architecture:                         aarch64\r\n" +
    "echo CPU op-mode(s):                       64-bit\r\n" +
    "echo Model name:                           Cloud Compute\r\n" +
    "echo CPU(s):                               10\r\n" +
    "echo Vendor:                               ARM\r\n" +
    "exit /b 0\r\n",
  "lsb_release.cmd":
    "@echo off\r\n" +
    "echo Distributor ID: Ubuntu\r\n" +
    "echo Description:    Ubuntu 24.04.1 LTS\r\n" +
    "echo Release:        24.04\r\n" +
    "echo Codename:       noble\r\n",
  "free.cmd":
    "@echo off\r\n" +
    "echo                total        used        free      shared  buff/cache   available\r\n" +
    "echo Mem:            15Gi       3.2Gi       8.1Gi       320Mi       4.1Gi        11Gi\r\n" +
    "echo Swap:          8.0Gi          0B       8.0Gi\r\n",
  "which.cmd": "@echo off\r\nwhere %1 2>nul\r\nif errorlevel 1 exit /b 1\r\n",
  "cat.cmd":
    "@echo off\r\n" +
    "for %%a in (%*) do (\r\n" +
    '  if /i "%%~a"=="/etc/os-release" goto osrelease\r\n' +
    '  if /i "%%~a"=="\\etc\\os-release" goto osrelease\r\n' +
    '  if /i "%%~a"=="/proc/cpuinfo" goto cpuinfo\r\n' +
    '  if /i "%%~a"=="\\proc\\cpuinfo" goto cpuinfo\r\n' +
    '  if /i "%%~a"=="/proc/meminfo" goto meminfo\r\n' +
    '  if /i "%%~a"=="\\proc\\meminfo" goto meminfo\r\n' +
    ")\r\n" +
    'if exist "C:\\Program Files\\Git\\usr\\bin\\cat.exe" ("C:\\Program Files\\Git\\usr\\bin\\cat.exe" %*)\r\n' +
    'if exist "C:\\Program Files\\Git\\usr\\bin\\cat.exe" exit /b %ERRORLEVEL%\r\n' +
    "for %%a in (%*) do (\r\n" +
    '  echo "%%~a"|findstr /r "^-" >nul || echo cat: %%~a: No such file or directory 1>&2\r\n' +
    ")\r\n" +
    "exit /b 1\r\n" +
    ":osrelease\r\n" +
    "echo NAME=Ubuntu\r\n" +
    'echo VERSION="24.04.1 LTS (Noble Numbat)"\r\n' +
    "echo ID=ubuntu\r\n" +
    "echo ID_LIKE=debian\r\n" +
    'echo PRETTY_NAME="Ubuntu 24.04.1 LTS"\r\n' +
    'echo VERSION_ID="24.04"\r\n' +
    'echo HOME_URL="https://www.ubuntu.com/"\r\n' +
    'echo SUPPORT_URL="https://help.ubuntu.com/"\r\n' +
    'echo BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"\r\n' +
    'echo PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"\r\n' +
    "echo VERSION_CODENAME=noble\r\n" +
    "echo UBUNTU_CODENAME=noble\r\n" +
    "echo LOGO=ubuntu-logo\r\n" +
    "exit /b 0\r\n" +
    ":cpuinfo\r\n" +
    cpuInfoCmdBody() +
    ":meminfo\r\n" +
    "echo MemTotal:       16464428 kB\r\n" +
    "echo MemFree:         8493312 kB\r\n" +
    "echo MemAvailable:   12177408 kB\r\n" +
    "echo Buffers:          321536 kB\r\n" +
    "echo Cached:          3902464 kB\r\n" +
    "echo SwapTotal:       8388604 kB\r\n" +
    "echo SwapFree:        8388604 kB\r\n" +
    "exit /b 0\r\n",
  "ls.cmd":
    "@echo off\r\n" +
    "setlocal enabledelayedexpansion\r\n" +
    'set "miss=0"\r\n' +
    'set "listed=0"\r\n' +
    ":loop\r\n" +
    'if "%~1"=="" goto decide\r\n' +
    'set "a=%~1"\r\n' +
    'echo(!a!|findstr /r "^-" >nul && goto next\r\n' +
    'echo(!a!|findstr /r "^/System" >nul && (echo ls: cannot access \'!a!\': No such file or directory 1>&2& set "miss=1"& goto next)\r\n' +
    'set "listed=1"\r\n' +
    ":next\r\n" +
    "shift\r\n" +
    "goto loop\r\n" +
    ":decide\r\n" +
    'if "%miss%"=="1" if "%listed%"=="0" exit /b 2\r\n' +
    'if exist "C:\\Program Files\\Git\\usr\\bin\\ls.exe" ("C:\\Program Files\\Git\\usr\\bin\\ls.exe" %*)&exit /b 0\r\n' +
    "dir /b %* 2>nul\r\n" +
    "exit /b 0\r\n",
}
