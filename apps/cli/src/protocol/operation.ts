// Generated from packages/protocol/control.schema.json by scripts/generate-control.mjs.
export type Operation =
  | { type: "list" }
  | { type: "shutdown"; force: boolean }
  | { type: "rename"; session: string; name: string }
  | { type: "scroll"; session: string; offset: number }
  | { type: "tmux-list" }
  | {
      type: "tmux-open";
      target?: string | null;
      name: string;
      cwd: string;
      rows: number;
      cols: number;
    }
  | { type: "fs-list"; path: string; exclusions: string[] }
  | { type: "fs-preview"; path: string }
  | {
      type: "create";
      command: string;
      args: string[];
      cwd: string;
      name: string;
      rows: number;
      cols: number;
      persistent: boolean;
      scrollback?: number;
    }
  | { type: "attach"; session: string }
  | { type: "detach"; session: string; force?: boolean }
  | { type: "snapshot"; session: string }
  | { type: "watch"; session: string; after: number }
  | { type: "pin"; session: string; persistent: boolean }
  | { type: "resize"; session: string; rows: number; cols: number }
  | { type: "kill"; session: string };
