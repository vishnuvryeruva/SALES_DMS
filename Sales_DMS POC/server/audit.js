/**
 * Audit trail of API calls, rule outcomes and the response shown to the user.
 * Each entry goes to stdout as one "[AUDIT] {json}" line (captured by `cf logs` / Application Logging),
 * to an append-only JSONL file, and to an in-memory buffer for the UI.
 */
import fs from 'node:fs';
import path from 'node:path';

export function createAuditLog({ file, keep, stdout = true }) {
  const recent = [];
  let fileOk = Boolean(file);
  if (fileOk) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    } catch {
      fileOk = false;
    }
  }

  return {
    record(entry) {
      const line = { at: new Date().toISOString(), ...entry };
      recent.unshift(line);
      if (recent.length > keep) recent.length = keep;
      if (stdout) console.log(`[AUDIT] ${JSON.stringify(line)}`);
      if (fileOk) {
        fs.appendFile(file, `${JSON.stringify(line)}\n`, (err) => {
          if (err) {
            fileOk = false;
            console.error('[AUDIT] File logging disabled:', err.message);
          }
        });
      }
      return line;
    },
    list(limit = 50) {
      return recent.slice(0, limit);
    },
  };
}

export function callSummary(result) {
  if (!result) return null;
  return {
    api: result.api,
    ok: result.ok,
    skipped: result.skipped || undefined,
    durationMs: result.durationMs,
    path: result.request?.path,
    error: result.error ? `${result.error.kind}: ${result.error.message}` : undefined,
  };
}
