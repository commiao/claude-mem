import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Derive the on-disk path to a Cursor agent transcript JSONL given the
 * workspace cwd and the conversation id. Cursor stores transcripts at:
 *
 *   ~/.cursor/projects/<workspace-slug>/agent-transcripts/<UUID>/<UUID>.jsonl
 *
 * where <workspace-slug> is the absolute cwd with the leading slash stripped
 * and any '/' or '.' replaced with '-' (e.g. /Users/foo.bar/workspaces ->
 * Users-foo-bar-workspaces). Returns undefined if the file does not exist.
 */
// Cursor session ids are UUID-style identifiers. Restrict to a safe character
// set so a malicious sessionId from stdin cannot escape ~/.cursor/projects via
// path separators, '..' segments, or null bytes (security review on PR #2282).
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const KNOWN_CURSOR_PAYLOAD_KEYS = new Set([
  'conversation_id',
  'generation_id',
  'id',
  'workspace_roots',
  'cwd',
  'prompt',
  'query',
  'input',
  'message',
  'command',
  'output',
  'tool_name',
  'tool_input',
  'result_json',
  'lastAssistantMessage',
  'last_assistant_message',
  'file_path',
  'edits',
]);

export function deriveCursorTranscriptPath(cwd: string | undefined, sessionId: string | undefined): string | undefined {
  if (!cwd || !sessionId) return undefined;
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return undefined;
  const slug = cwd.replace(/^\//, '').replace(/[/.]/g, '-');
  const candidate = join(homedir(), '.cursor', 'projects', slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
  return existsSync(candidate) ? candidate : undefined;
}

export const cursorAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const payloadKeys = Object.keys(r).sort();
    const unknownFields = payloadKeys.filter((key) => !KNOWN_CURSOR_PAYLOAD_KEYS.has(key));
    const diagnostics: string[] = [];
    const isShellCommand = !!r.command && !r.tool_name;
    const cwd = r.workspace_roots?.[0] ?? r.cwd ?? process.cwd();
    if (!r.workspace_roots?.[0] && !r.cwd) {
      diagnostics.push('cwd_from_process');
    }
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    let sessionId: string | undefined;
    let sessionIdSource: string | undefined;
    if (r.conversation_id) {
      sessionId = r.conversation_id;
      sessionIdSource = 'conversation_id';
    } else if (r.generation_id) {
      sessionId = r.generation_id;
      sessionIdSource = 'generation_id';
      diagnostics.push('session_id_from_generation_id');
    } else if (r.id) {
      sessionId = r.id;
      sessionIdSource = 'id';
      diagnostics.push('session_id_from_id');
    } else {
      diagnostics.push('missing_session_id');
    }
    if (isShellCommand && r.output === undefined) {
      diagnostics.push('shell_missing_output');
    }
    if (!isShellCommand && !r.tool_name && (r.tool_input !== undefined || r.result_json !== undefined)) {
      diagnostics.push('missing_tool_name');
    }
    if (unknownFields.length > 0) {
      diagnostics.push('unknown_payload_fields');
    }
    if (diagnostics.length > 0) {
      logger.warn('CURSOR', 'Cursor hook payload diagnostics', {
        diagnostics,
        sessionIdSource,
        payloadKeys,
        unknownFields,
      });
    }
    return {
      sessionId,
      cwd,
      prompt: r.prompt ?? r.query ?? r.input ?? r.message,
      toolName: isShellCommand ? 'Bash' : r.tool_name,
      toolInput: isShellCommand ? { command: r.command } : r.tool_input,
      toolResponse: isShellCommand ? { output: r.output } : r.result_json,  // result_json not tool_response
      lastAssistantMessage: r.lastAssistantMessage ?? r.last_assistant_message,
      // Cursor's stop hook does not pass a transcript path on stdin, but it
      // does write a JSONL transcript to disk under ~/.cursor/projects/...,
      // so we derive the path from cwd + conversation id.
      transcriptPath: deriveCursorTranscriptPath(cwd, sessionId),
      filePath: r.file_path,
      edits: r.edits,
      metadata: {
        cursorSessionIdSource: sessionIdSource,
        cursorPayloadKeys: payloadKeys,
        cursorUnknownFields: unknownFields,
        cursorDiagnostics: diagnostics,
      },
    };
  },
  formatOutput(result) {
    return { continue: result.continue ?? true };
  }
};
