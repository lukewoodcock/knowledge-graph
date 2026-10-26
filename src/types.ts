/** Context received from the IDE webhook, normalised. */
export interface SwarmContext {
  filePath: string;
  language: string;
  description: string;
  changedCode: string;
  today: string;
  /** Claude Code session the capture came from, when the source sent one. */
  session?: string;
  /** Project the capture came from, when the source sent one. */
  project?: string;
}

/** A note a run just wrote: by the Documenter or Researcher, or a memo. */
export interface NoteResult {
  agent: 'documenter' | 'researcher' | 'memo';
  status: 'success';
  notePath: string;
  title: string;
}

/** Result returned by the Linker agent. */
export interface LinkerResult {
  agent: 'linker';
  status: 'success';
  linksWritten: number;
}
