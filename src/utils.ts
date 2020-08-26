'use strict';

import * as child_process from 'child_process';
import * as fs from 'fs';

/*
 * Checks if the executable is on the PATH
 */
export function executableExists(exe: string): boolean {
  const isWindows = process.platform === 'win32';
  const cmd: string = isWindows ? 'where' : 'which';
  const out = child_process.spawnSync(cmd, [exe]);
  return out.status === 0 || (isWindows && fs.existsSync(exe));
}
