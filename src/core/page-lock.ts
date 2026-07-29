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
 * File contents: `{pid}\n{iso-timestamp}\n{holder-token}`. A lock is
 * reclaimable only when its PID is no longer alive on this host. Live locks
 * are never stolen solely because a wall-clock timeout elapsed.
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
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  // Note: unlike cycle.ts (single lock per process), page-lock allows
  // multiple concurrent locks per process for DIFFERENT slugs. A same-pid
  // collision on the SAME slug means another concurrent caller in this
  // process holds it — treat as live and never steal it.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ESRCH = no such process; anything else (e.g. EPERM) = still alive.
    return code !== 'ESRCH';
  }
}

interface LockRecord {
  pid: number;
  timestamp: string;
  token: string;
}

function parseLockRecord(content: string): LockRecord {
  const [pidText = '0', timestamp = '', token = ''] = content.trim().split('\n');
  return {
    pid: parseInt(pidText, 10),
    timestamp,
    token,
  };
}

function lockRecordText(record: LockRecord): string {
  return `${record.pid}\n${record.timestamp}\n${record.token}\n`;
}

function writeExclusiveLock(lockPath: string, record: LockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeFileSync(fd, lockRecordText(record), 'utf-8');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`page lock is not a regular file: ${lockPath}`);
  } finally {
    closeSync(fd);
  }
  return true;
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
  const pid = process.pid;
  const token = randomUUID();
  const record = (): LockRecord => ({
    pid,
    timestamp: new Date().toISOString(),
    token,
  });

  if (!writeExclusiveLock(lockPath, record())) {
    try {
      const before = statSync(lockPath);
      const content = readFileSync(lockPath, 'utf-8').trim();
      const existing = parseLockRecord(content);
      const pidAlive = isPidAlive(existing.pid);

      // Never steal from a live process merely because time elapsed. The
      // previous timeout-or-dead rule allowed a long-running writer to lose
      // exclusivity between refreshes. PID liveness is the reclaim authority.
      if (pidAlive) return null;
      // Reclaim only the exact stale inode we inspected. The subsequent
      // O_EXCL create is the arbitration point if another waiter races us.
      const after = statSync(lockPath);
      const afterContent = readFileSync(lockPath, 'utf-8').trim();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs ||
        content !== afterContent
      ) return null;
      unlinkSync(lockPath);
    } catch {
      // A concurrent owner may have refreshed/replaced the path. Never
      // overwrite it; retry through the O_EXCL arbitration point instead.
      return null;
    }
    if (!writeExclusiveLock(lockPath, record())) return null;
  }

  return {
    slug,
    refresh: async () => {
      try {
        const held = parseLockRecord(readFileSync(lockPath, 'utf-8'));
        if (held.pid !== pid || held.token !== token) return;
        const now = new Date();
        utimesSync(lockPath, now, now);
      } catch {
        /* non-fatal — next acquirer will see it as stale */
      }
    },
    release: async () => {
      try {
        const held = parseLockRecord(readFileSync(lockPath, 'utf-8'));
        if (held.pid === pid && held.token === token) unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
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
