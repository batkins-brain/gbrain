/**
 * v0.28: per-page file lock for atomic markdown read-modify-write.
 *
 * Eng-review fold: reuses the v0.17 `~/.gbrain/cycle.lock` PID-liveness
 * pattern (src/core/cycle.ts:acquireFileLock) but scoped per page so two
 * parallel `gbrain takes add` calls + a `takes seed --refresh` running in
 * autopilot can't race on the same `<slug>.md` file.
 *
 * Lock file path: `~/.gbrain/page-locks/<sha256-of-slug>.lock`. SHA-256
 * keeps filenames safe regardless of slug content (slashes, unicode, etc.).
 *
 * The persistent file carries diagnostic `{pid}\n{iso-timestamp}\n{holder-token}`
 * content. Kernel `flock(2)` is the lock authority: acquisition is atomic and
 * inode-bound, and a crash releases the lock automatically when the fd closes.
 *
 * Usage:
 *
 *   const lock = await acquirePageLock(slug, { timeoutMs: 30_000 });
 *   try {
 *     // read-modify-write the markdown file
 *   } finally {
 *     await lock.release();
 *   }
 */

import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dlopen, FFIType } from 'bun:ffi';
import { gbrainPath } from './config.ts';

export interface PageLockHandle {
  /** Release the lock if we still hold it. Idempotent. */
  release: () => Promise<void>;
  /** Refresh diagnostic mtime without changing the holder identity record. */
  refresh: () => Promise<void>;
  /** Slug the lock was acquired for (for diagnostics). */
  slug: string;
}

export interface AcquirePageLockOpts {
  /** Total wait budget before giving up. Default 0 (no wait — fail fast). */
  timeoutMs?: number;
  /** Polling interval while waiting. Default 200ms. */
  pollMs?: number;
  /** Override lock root for tests. */
  lockRoot?: string;
}

function lockPathFor(slug: string, lockRoot?: string): string {
  const sha = createHash('sha256').update(slug).digest('hex');
  const dir = lockRoot ?? gbrainPath('page-locks');
  return join(dir, `${sha}.lock`);
}

interface LockRecord {
  pid: number;
  timestamp: string;
  token: string;
}

function lockRecordText(record: LockRecord): string {
  return `${record.pid}\n${record.timestamp}\n${record.token}\n`;
}

interface FlockSymbols {
  flock: (fd: number, operation: number) => number;
}

let flockLibrary: ReturnType<typeof dlopen> | null = null;
let flockSymbols: FlockSymbols | null = null;

function getFlockSymbols(): FlockSymbols {
  if (flockSymbols) return flockSymbols;
  const library =
    process.platform === 'darwin'
      ? '/usr/lib/libSystem.B.dylib'
      : process.platform === 'linux'
        ? 'libc.so.6'
        : null;
  if (!library) throw new Error('page locks require POSIX flock support');
  flockLibrary = dlopen(library, {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  flockSymbols = flockLibrary.symbols as unknown as FlockSymbols;
  return flockSymbols;
}

function writeLockRecord(fd: number, record: LockRecord): void {
  const body = lockRecordText(record);
  ftruncateSync(fd, 0);
  writeSync(fd, body, 0, 'utf-8');
  fsyncSync(fd);
}

function tryAcquireOnce(slug: string, lockPath: string): PageLockHandle | null {
  const dir = join(lockPath, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let dirStat = lstatSync(dir);
  const effectiveUid = process.getuid?.();
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (effectiveUid !== undefined && dirStat.uid !== effectiveUid)
  ) {
    throw new Error(`page-lock root is not a private, caller-owned directory: ${dir}`);
  }
  if ((dirStat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    dirStat = lstatSync(dir);
    if ((dirStat.mode & 0o077) !== 0) {
      throw new Error(`page-lock root permissions could not be restricted: ${dir}`);
    }
  }

  const fd = openSync(
    lockPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  // flock is the authority. It is atomic, inode-bound, and released by the
  // kernel on process exit, eliminating initialization, stale-reclaim, and
  // read/check/unlink races from the former PID-file protocol.
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  const LOCK_UN = 8;
  let locked = false;
  try {
    const lockStat = fstatSync(fd);
    if (
      !lockStat.isFile() ||
      (effectiveUid !== undefined && lockStat.uid !== effectiveUid)
    ) {
      throw new Error(`page lock is not a caller-owned regular file: ${lockPath}`);
    }
    if ((lockStat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);

    if (getFlockSymbols().flock(fd, LOCK_EX | LOCK_NB) < 0) {
      closeSync(fd);
      return null;
    }
    locked = true;

    const token = randomUUID();
    const record = (): LockRecord => ({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      token,
    });
    writeLockRecord(fd, record());

    let released = false;
    return {
      slug,
      refresh: async () => {
        if (!released) writeLockRecord(fd, record());
      },
      release: async () => {
        if (released) return;
        released = true;
        try {
          getFlockSymbols().flock(fd, LOCK_UN);
        } finally {
          closeSync(fd);
        }
      },
    };
  } catch (error) {
    try {
      if (locked) getFlockSymbols().flock(fd, LOCK_UN);
    } finally {
      closeSync(fd);
    }
    throw error;
  }
}

/**
 * Acquire a per-page lock. By default fails fast (timeoutMs=0) — a live
 * holder returns null. Pass timeoutMs > 0 to poll until acquired or the
 * deadline expires.
 */
export async function acquirePageLock(
  slug: string,
  opts: AcquirePageLockOpts = {},
): Promise<PageLockHandle | null> {
  const lockPath = lockPathFor(slug, opts.lockRoot);
  const deadline = Date.now() + (opts.timeoutMs ?? 0);
  const pollMs = opts.pollMs ?? 200;

  let attempt = tryAcquireOnce(slug, lockPath);
  if (attempt) return attempt;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    attempt = tryAcquireOnce(slug, lockPath);
    if (attempt) return attempt;
  }

  return null;
}

/**
 * Convenience wrapper: acquire, run fn, release. Throws if the lock
 * cannot be acquired within the timeout.
 */
export async function withPageLock<T>(
  slug: string,
  fn: () => Promise<T>,
  opts: AcquirePageLockOpts = {},
): Promise<T> {
  const handle = await acquirePageLock(slug, { timeoutMs: 30_000, ...opts });
  if (!handle) {
    throw new Error(`acquirePageLock: could not acquire lock for slug "${slug}" within ${opts.timeoutMs ?? 30_000}ms`);
  }
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
