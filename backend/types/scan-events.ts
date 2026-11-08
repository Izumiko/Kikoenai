/*
 * The messages the forked scanner process and its parent exchange over IPC.
 *
 * `socket.ts` forks `filesystem/scanner.ts` / `updater.ts` /
 * `workFileScanner.ts`, and each of those binds `filesystem/scannerModules.ts`.
 * The child reports progress line by line (`SCAN_MAIN_LOG`, `SCAN_TASK_*`,
 * `SCAN_RESULT`, …) and can be asked for the accumulated snapshot
 * (`SCAN_INIT_STATE`); the parent relays every event it receives to the
 * connected clients unchanged. Both ends import these shapes so an event name
 * or payload cannot drift between them.
 */

/** The levels `LOG` writes with; also the `console` methods it calls. */
export type ScanLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One line of a scan log, as shown in the page and written to the log file. */
export interface ScanLogEntry {
  level: ScanLogLevel;
  message: string;
}

/** The outcome of one work's processing, as the scanner records it. */
export type ScanTaskResult = 'added' | 'failed' | 'skipped' | 'updated';

/** One work's own log, plus its outcome once it has been removed. */
export interface ScanTask {
  /** The work id (`123456`, `d215444`, …). */
  rjcode: string;
  /** `null` while the work is still being processed. */
  result: ScanTaskResult | null;
  logs: ScanLogEntry[];
}

/** One finished work, as the results panel counts it. */
export interface ScanResultEntry {
  rjcode: string;
  result: ScanTaskResult;
  count: number;
}

/** The bounded snapshot the child sends on `SCAN_INIT_STATE`. */
export interface ScanInitState {
  tasks: ScanTask[];
  failedTasks: ScanTask[];
  mainLogs: ScanLogEntry[];
  results: ScanResultEntry[];
}

/** Child → parent. Every event is relayed to the clients as-is. */
export type ScanEvent =
  | { event: 'SCAN_FINISHED'; payload: { message: string } }
  | { event: 'SCAN_MAIN_LOG'; payload: { entry: ScanLogEntry } }
  | { event: 'SCAN_TASK_ADD'; payload: { rjcode: string } }
  | { event: 'SCAN_TASK_LOG'; payload: { rjcode: string; entry: ScanLogEntry } }
  | { event: 'SCAN_TASK_REMOVE'; payload: { rjcode: string; result: ScanTaskResult } }
  | { event: 'SCAN_FAILED_TASK'; payload: { task: ScanTask } }
  | { event: 'SCAN_RESULT'; payload: { result: ScanResultEntry } }
  | { event: 'SCAN_INIT_STATE'; payload: ScanInitState };

/**
 * Parent → child. Both fields are optional so a message can be checked with a
 * plain comparison, exactly as the child always has.
 */
export interface ScanCommand {
  /** Ask for the accumulated snapshot (sent on page load and reconnect). */
  emit?: 'SCAN_INIT_STATE';
  /** Ask the scanner to stop. */
  exit?: number;
}
