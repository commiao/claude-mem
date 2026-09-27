import type { NormalizedHookInput } from './types.js';
import { extractLastAssistantTurn } from '../shared/transcript-parser.js';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const MUTATIONS = new Set(['session-init', 'observation', 'summarize', 'session-end', 'user-message', 'file-edit']);

/** A temporary admission journal, distinct from replaying any old observer task. */
export function journalCaptureHandoff(platform: string, event: string, raw: unknown, input: NormalizedHookInput): boolean {
  if (!MUTATIONS.has(event)) return false;
  const control = process.env.CLAUDE_MEM_HANDOFF_CONTROL || join(homedir(), '.claude-mem', 'capture-handoff.json');
  if (!existsSync(control)) {
    if (process.env.CLAUDE_MEM_HANDOFF_REPLAY) throw new Error('Capture handoff control missing');
    return false;
  }
  const config = JSON.parse(readFileSync(control, 'utf8'));
  if (typeof config.generation !== 'string' || typeof config.journal !== 'string') {
    throw new Error('Invalid capture handoff control');
  }
  const replay = process.env.CLAUDE_MEM_HANDOFF_REPLAY;
  if (replay) {
    if (replay !== config.generation) throw new Error('Capture handoff replay generation mismatch');
    return false;
  }
  const db = new Database(config.journal, { readwrite: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL');
    return db.transaction(() => {
      const state = db.query('SELECT generation,phase FROM handoff_control WHERE id=1').get() as { generation: string; phase: string } | null;
      if (!state || state.generation !== config.generation) throw new Error('Capture handoff journal identity mismatch');
      if (state.phase === 'closed') return false;
      if (state.phase !== 'capture') throw new Error('Unknown capture handoff phase');
      const frozen = { ...input };
      if (event === 'summarize' && frozen.lastAssistantMessage === undefined) {
        frozen.lastAssistantMessage = frozen.transcriptPath ? extractLastAssistantTurn(frozen.transcriptPath, true).text : '';
      }
      db.query('INSERT INTO handoff_events(platform,event,payload,state) VALUES(?,?,?,\'queued\')')
        .run(platform, event, JSON.stringify({ rawInput: raw, normalizedInput: frozen }));
      return true;
    }).immediate();
  } finally { db.close(); }
}
