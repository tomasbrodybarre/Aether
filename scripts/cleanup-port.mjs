/**
 * Pre-dev cleanup script for Aether.
 *
 * Detects and kills stale Aether dev server processes on port 3000
 * before starting a new instance. Verifies the process is actually
 * a Node/Next.js process before killing — won't touch unrelated services.
 */

import { execSync } from 'child_process';

const PORT = 3000;

function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano`, { encoding: 'utf8' });
      for (const line of output.split('\n')) {
        // Match LISTENING on our port (both IPv4 and IPv6)
        const match = line.match(new RegExp(`\\s+(?:0\\.0\\.0\\.0|\\[::\\]):${port}\\s+.*LISTENING\\s+(\\d+)`));
        if (match) return parseInt(match[1], 10);
      }
    } else {
      // macOS / Linux
      const output = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' });
      const pid = parseInt(output.trim(), 10);
      if (!isNaN(pid)) return pid;
    }
  } catch {
    // Command failed or no results — port is free
  }
  return null;
}

function getProcessInfo(pid) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `powershell.exe -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId, Name, CommandLine, CreationDate | ConvertTo-Json"`,
        { encoding: 'utf8' }
      );
      return JSON.parse(output);
    } else {
      const cmd = execSync(`ps -p ${pid} -o pid=,comm=,args=,lstart=`, { encoding: 'utf8' });
      return { CommandLine: cmd.trim(), Name: 'unknown' };
    }
  } catch {
    return null;
  }
}

function isAetherProcess(info) {
  if (!info) return false;
  const cmdLine = (info.CommandLine || '').toLowerCase();
  // Must be a node process running next dev
  return cmdLine.includes('node') && cmdLine.includes('next');
}

function killProcess(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

// Main
const pid = findPidOnPort(PORT);

if (!pid) {
  // Port is free — nothing to do
  process.exit(0);
}

const info = getProcessInfo(pid);

if (!isAetherProcess(info)) {
  console.warn(
    `[cleanup] Port ${PORT} is in use by a non-Aether process (PID ${pid}: ${info?.Name || 'unknown'}).`
  );
  console.warn(`[cleanup] Not killing it. Aether will start on an alternate port.`);
  process.exit(0);
}

// It's a stale Aether process — kill it
const created = info.CreationDate
  ? new Date(info.CreationDate).toLocaleString()
  : 'unknown time';

console.log(`[cleanup] Found stale Aether dev server (PID ${pid}, started ${created}) on port ${PORT}.`);

if (killProcess(pid)) {
  console.log(`[cleanup] Killed stale process. Port ${PORT} is now free.`);
} else {
  console.warn(`[cleanup] Failed to kill PID ${pid}. Aether will start on an alternate port.`);
}
