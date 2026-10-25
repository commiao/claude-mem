/** Pure production post-processing, shared with offline evaluation. No worker, DB or notifications. */
import type { PendingMessage } from '../../worker-types.js';
import type { ParsedObservation, ParsedSummary } from '../../../sdk/parser.js';

type ObservationFileEvidenceMessage = Pick<PendingMessage, 'type' | 'tool_name' | 'tool_input'>;

export interface ObservationFileEvidence {
  files_read: string[];
  files_modified: string[];
}

const READ_TOOL_NAMES = new Set(['Read']);
const WRITE_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'write_file']);
const PATCH_TOOL_NAMES = new Set(['apply_patch']);

export function extractObservationFileEvidence(messages: ReadonlyArray<ObservationFileEvidenceMessage>): ObservationFileEvidence {
  const filesRead: string[] = [];
  const filesModified: string[] = [];
  const seenRead = new Set<string>();
  const seenModified = new Set<string>();

  for (const message of messages) {
    if (message.type !== 'observation') {
      continue;
    }

    const toolName = typeof message.tool_name === 'string' ? message.tool_name : '';
    if (!toolName) {
      continue;
    }

    if (READ_TOOL_NAMES.has(toolName)) {
      for (const filePath of extractPathsFromToolInput(message.tool_input, 'read')) {
        pushUnique(seenRead, filesRead, filePath);
      }
    }

    if (WRITE_TOOL_NAMES.has(toolName)) {
      for (const filePath of extractPathsFromToolInput(message.tool_input, 'write', toolName)) {
        pushUnique(seenModified, filesModified, filePath);
      }
    }

    if (PATCH_TOOL_NAMES.has(toolName)) {
      for (const filePath of extractPatchPaths(message.tool_input)) {
        pushUnique(seenModified, filesModified, filePath);
      }
    }
  }

  return {
    files_read: filesRead,
    files_modified: filesModified,
  };
}

function pushUnique(seen: Set<string>, output: string[], filePath: string): void {
  if (!seen.has(filePath)) {
    seen.add(filePath);
    output.push(filePath);
  }
}

function normalizePathValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim() ? value : null;
}

function maybeParseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || !(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function extractPathsFromToolInput(
  toolInput: unknown,
  mode: 'read' | 'write',
  toolName?: string
): string[] {
  const input = maybeParseObject(toolInput);
  if (!input) {
    return [];
  }

  const paths: string[] = [];
  const directFields = mode === 'read'
    ? ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'filePaths']
    : ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'filePaths'];

  for (const field of directFields) {
    const value = input[field];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const path = normalizePathValue(entry);
        if (path) {
          paths.push(path);
        }
      }
      continue;
    }

    const path = normalizePathValue(value);
    if (path) {
      paths.push(path);
    }
  }

  if (mode === 'write') {
    const edits = input.edits;
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object') {
          continue;
        }
        const record = edit as Record<string, unknown>;
        for (const field of ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path']) {
          const path = normalizePathValue(record[field]);
          if (path) {
            paths.push(path);
          }
        }
        const patch = normalizePathValue(record.patch);
        if (patch && toolName === 'apply_patch') {
          paths.push(...extractPatchPaths(patch));
        }
      }
    }
  }

  return dedupeStable(paths);
}

function extractPatchPaths(toolInput: unknown): string[] {
  const input = maybeParseObject(toolInput);
  if (!input) {
    return typeof toolInput === 'string' ? parsePatchFiles(toolInput) : [];
  }

  const patches: string[] = [];
  // Codex's apply_patch hook carries the raw patch in tool_input.command.
  for (const field of ['patch', 'command']) {
    const patch = normalizePathValue(input[field]);
    if (patch) {
      patches.push(patch);
    }
  }

  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (typeof edit === 'string') {
        patches.push(edit);
        continue;
      }
      if (!edit || typeof edit !== 'object') {
        continue;
      }
      const record = edit as Record<string, unknown>;
      const nestedPatch = normalizePathValue(record.patch);
      if (nestedPatch) {
        patches.push(nestedPatch);
      }
    }
  }

  return dedupeStable(patches.flatMap(parsePatchFiles));
}

function parsePatchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*** Update File: ')) {
      files.push(trimmed.replace('*** Update File: ', '').trim());
      continue;
    }
    if (trimmed.startsWith('*** Add File: ')) {
      files.push(trimmed.replace('*** Add File: ', '').trim());
      continue;
    }
    if (trimmed.startsWith('*** Delete File: ')) {
      files.push(trimmed.replace('*** Delete File: ', '').trim());
      continue;
    }
    if (trimmed.startsWith('*** Move to: ')) {
      files.push(trimmed.replace('*** Move to: ', '').trim());
      continue;
    }
    if (trimmed.startsWith('+++ ')) {
      const filePath = trimmed.replace('+++ ', '').replace(/^b\//, '').trim();
      if (filePath && filePath !== '/dev/null') {
        files.push(filePath);
      }
    }
  }
  return dedupeStable(files);
}

function dedupeStable(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

export function sanitizeObservationFiles(
  observations: ParsedObservation[],
  fileEvidence: ObservationFileEvidence
): ParsedObservation[] {
  return observations.map(obs => ({
    ...obs,
    files_read: mergeFileLists(fileEvidence.files_read, obs.files_read),
    files_modified: fileEvidence.files_modified,
  }));
}

function mergeFileLists(primary: string[], secondary: string[]): string[] {
  return dedupeStable([...primary, ...secondary]);
}


export function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
  files_read: string[];
  files_edited: string[];
} | null {
  if (!summary) return null;
  if (summary.skipped) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes,
    files_read: [],
    files_edited: [],
  };
}

export function attachObservationFilesToSummary(
  summary: {
    request: string;
    investigated: string;
    learned: string;
    completed: string;
    next_steps: string;
    notes: string | null;
    files_read?: string[];
    files_edited?: string[];
  } | null,
  observations: Array<{ files_read?: string[] | null; files_modified?: string[] | null }>
): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
  files_read: string[];
  files_edited: string[];
} | null {
  if (!summary) return null;
  const filesRead = dedupeStable([
    ...(summary.files_read ?? []),
    ...observations.flatMap((obs) => obs.files_read ?? []),
  ]);
  const filesEdited = dedupeStable([
    ...(summary.files_edited ?? []),
    ...observations.flatMap((obs) => obs.files_modified ?? []),
  ]);
  return {
    ...summary,
    files_read: filesRead,
    files_edited: filesEdited,
  };
}

