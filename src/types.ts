/** A code capture as the trigger endpoint received it, normalised. */
export interface CodeCapture {
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

/** A note a run just wrote: the Documenter's, the Researcher's, or a memo's. */
export interface WrittenNote {
  /** The note's type, as its frontmatter gives it. */
  type: 'code' | 'research' | 'memo';
  notePath: string;
  title: string;
}

/** Where a run is: queued or going, or how it finished. */
export type RunStatus = 'running' | 'complete' | 'partial' | 'error';

/** Result returned by the Linker agent. */
export interface LinkerResult {
  agent: 'linker';
  status: 'success';
  linksWritten: number;
}
