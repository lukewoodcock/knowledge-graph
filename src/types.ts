/** Context received from the IDE webhook, normalised. */
export interface SwarmContext {
  filePath: string;
  language: string;
  description: string;
  changedCode: string;
  today: string;
}

/** Result returned by the Documenter and Researcher agents. */
export interface NoteResult {
  agent: 'documenter' | 'researcher';
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
