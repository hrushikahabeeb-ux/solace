import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads apps/server/.env into process.env before anything reads configuration.
 *
 * Previously this happened implicitly when Prisma Client was first constructed, which
 * made correctness depend on module import order. Loading it explicitly as the first
 * import removes that coupling. Variables already present in the environment (for
 * example, set by a process manager in production) always take precedence.
 */

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    result[key] = value;
  }
  return result;
}

export function loadServerEnv(envPath?: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/lib (tsx) and dist/lib (compiled) are both two levels below apps/server.
  const path = envPath ?? resolve(here, '..', '..', '.env');
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadServerEnv();
