// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const terminalLocalHistory = new Map<string, string[]>(); // blockId -> history array

export function addCommandToHistory(blockId: string, cmd: string) {
    cmd = cmd.trim();
    if (!cmd) return;
    let history = terminalLocalHistory.get(blockId);
    if (!history) {
        history = [];
        terminalLocalHistory.set(blockId, history);
    }
    // Remove duplicate so the command is moved to the end (latest)
    const idx = history.indexOf(cmd);
    if (idx !== -1) {
        history.splice(idx, 1);
    }
    history.push(cmd);
    if (history.length > 500) {
        history.shift();
    }
}

export function getCommandHistory(blockId: string): string[] {
    return terminalLocalHistory.get(blockId) || [];
}

export function stripPrompt(line: string): string {
    line = line.trim();
    // 1. Windows PowerShell: PS C:\path> cmd
    const psMatch = line.match(/^PS\s+[A-Za-z]:\\[^>]*>\s*(.*)$/);
    if (psMatch) return psMatch[1].trim();

    // 2. Windows Cmd: C:\path> cmd
    const cmdMatch = line.match(/^[A-Za-z]:\\[^>]*>\s*(.*)$/);
    if (cmdMatch) return cmdMatch[1].trim();

    // 3. Linux/Unix standard: [user@host path]$ cmd or user@host:path$ cmd or root@host~]# cmd
    const unixMatch = line.match(/^(?:\[?[a-zA-Z0-9_\-\.]+@[a-zA-Z0-9_\-\.]+\s+[^\]]+\]?[\$#%]\s*|[^@\s]+@[^:\s]+:[~\/][^\$#%]*[\$#%]\s*)(.*)$/);
    if (unixMatch) return unixMatch[1].trim();

    // 4. Fallback: if it's just a simple prompt like "$ cmd" or "# cmd" or "> cmd"
    const simpleMatch = line.match(/^[\$#>%]\s*(.*)$/);
    if (simpleMatch) return simpleMatch[1].trim();

    return line;
}
