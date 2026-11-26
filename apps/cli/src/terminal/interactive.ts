import { posix } from "node:path";
import { availableUpdate, skipUpdate } from "../release/updates.js";
import { restartAfterUpdate } from "../release/restart.js";
import { Explorer } from "../explorer/explorer.js";
import { isViewableFile, openLocalFile } from "../explorer/open-file.js";
import { localForegroundSsh } from "./local-foreground-ssh.js";
import { workingDirectories } from "./working-directories.js";
import { workspaceDirectory } from "../explorer/workspace-directory.js";
import { setTimeout as delay } from "node:timers/promises";
import { connectRemoteAgent } from "../agent/ssh.js";
import { connectLocalAgent } from "../agent/local.js";
import type { Config } from "../config/schema.js";
import type { SessionClient } from "../protocol/client.js";
import type { MouseEvent, TerminalInput } from "./input.js";
import { mountRawInput } from "./raw-input.js";
import { CommandPalette, type PaletteAction } from "./palette.js";
import { closeDialogInput } from "./close-dialog.js";
import { sidebarActionAt } from "./sidebar-actions.js";
import { SidebarLayout } from "./sidebar-layout.js";
import { openSshShell } from "./ssh-shell.js";
import { paletteShortcut, type Mode } from "./view.js";
import { workspaceScreen } from "./workspace-screen.js";
import { listTmux, openTmux, type TmuxTarget } from "./tmux.js";
import { TerminalWatch } from "./watch.js";
import { watchWorkspaceList } from "./workspace-refresh.js";
import { terminalMouse } from "./mouse.js";
import {
  contains,
  PaneLayout,
  paneSize,
  type Divider,
  type Rect,
} from "./panes.js";
import { PaneWatches } from "./pane-watches.js";
import { geometry, Screen } from "./screen.js";
import { decodeSnapshot, type TerminalSnapshot } from "./snapshot.js";
import {
  createWorkspace,
  decodeWorkspace,
  listWorkspaces,
  reconcileWorkspaces,
  type NativeWorkspace,
} from "./workspaces.js";

type WorkspaceResult =
  | { type: "update"; version: string; session: string | undefined }
  | { type: "host"; host: string | undefined; client: SessionClient };

type ExitPolicy = Exclude<Config["defaults"]["on_exit"], "ask">;
type RenameDraft = {
  id: string;
  name: string;
  replace: boolean;
  returnTo: "terminal" | "palette";
};

export async function runInteractive(
  config: Config,
  requested?: string,
  host?: string,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The workspace UI requires a terminal.");
  let next: WorkspaceResult | undefined;
  let target = requested;
  let currentHost = host;
  let prepared: SessionClient | undefined;
  do {
    const alias = currentHost;
    const connect = alias ? () => connectRemoteAgent(alias) : connectLocalAgent;
    const client = prepared ?? (await connect());
    prepared = undefined;
    try {
      next = await new InteractiveWorkspace(client, config, alias, connect).run(
        target,
      );
    } finally {
      client.close();
    }
    target = undefined;
    if (next?.type === "update")
      await restartAfterUpdate(next.version, alias, next.session);
    if (next?.type === "host") {
      currentHost = next.host;
      prepared = next.client;
    }
  } while (prepared);
}

function hasLease(reply: unknown): boolean {
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("controlsInput" in reply) ||
    typeof reply.controlsInput !== "boolean"
  ) {
    throw new Error("Invalid attachment response");
  }
  return reply.controlsInput;
}

class InteractiveWorkspace {
  #client: SessionClient;
  readonly #config: Config;
  readonly #host: string | undefined;
  readonly #connect: () => Promise<SessionClient>;
  readonly #screen = new Screen(process.stdout);
  readonly #sidebar = new SidebarLayout();
  readonly #panes = new PaneLayout();
  readonly #paneWatches: PaneWatches;
  #paneDrag: { id: string; moved: boolean; preview?: Rect } | undefined;
  #paneDivider: Divider | undefined;
  readonly #explorer: Explorer;
  #layout = geometry(process.stdout.rows || 24, process.stdout.columns || 80);
  #mode: Mode = "terminal";
  #closeTarget: NativeWorkspace | undefined;
  #status = "";
  #update: string | undefined;
  #result: WorkspaceResult | undefined;
  #hosts: (string | undefined)[] = [];
  #hostIndex = 0;
  #hostTrial = 0;
  #history: TerminalSnapshot | undefined;
  #offset = 0;
  #renameDraft: RenameDraft | undefined;
  #palette: CommandPalette | undefined;
  #sshTarget = "";
  #tmux: TmuxTarget[] = [];
  #tmuxIndex = 0;
  #workspaces: NativeWorkspace[] = [];
  #selected: NativeWorkspace | undefined;
  #snapshot: TerminalSnapshot | undefined;
  #controlsInput = false;
  #watcher: TerminalWatch;
  #stopped = false;
  #receivedInput = false;
  #resizePending = false;
  #jobs = Promise.resolve();
  #resolveExit: (() => void) | undefined;

  constructor(
    client: SessionClient,
    config: Config,
    host: string | undefined,
    connect: () => Promise<SessionClient>,
  ) {
    this.#client = client;
    this.#config = config;
    this.#host = host;
    this.#connect = connect;
    this.#watcher = new TerminalWatch(connect);
    this.#paneWatches = new PaneWatches(connect);
    this.#explorer = new Explorer(connect, config.explorer.exclusions, () =>
      this.#draw(),
    );
  }

  async run(
    requested: string | undefined,
  ): Promise<WorkspaceResult | undefined> {
    this.#workspaces = (await listWorkspaces(this.#client)).filter(
      ({ running }) => running,
    );
    const target = requested
      ? this.#workspaces.find(
          ({ id, name }) => id === requested || name === requested,
        )
      : (this.#workspaces.find(
          ({ id }) => id === process.env.RUCAN_RESUME_SESSION,
        ) ?? this.#workspaces[0]);
    delete process.env.RUCAN_RESUME_SESSION;
    if (requested && !target) throw new Error(`Unknown session ${requested}`);

    const onResize = (): void => {
      if (this.#resizePending) return;
      this.#resizePending = true;
      this.#enqueue(async () => {
        this.#resizePending = false;
        this.#layout = geometry(
          process.stdout.rows || 24,
          process.stdout.columns || 80,
          this.#sidebar.preferred,
          this.#sidebar.side,
        );
        if (!this.#layout.sidebar) this.#sidebar.cancelDrag();
        this.#paneDrag = undefined;
        this.#paneDivider = undefined;
        this.#draw();
        await this.#resize();
      });
    };
    const done = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#screen.enter();
    let unmount: (() => void) | undefined;
    let stopRefresh: (() => void) | undefined;
    try {
      await this.#select(target ?? (await this.#new()), false);
      if (this.#stopped) return;
      unmount = mountRawInput({
        input: (events) => {
          this.#receivedInput = true;
          return this.#enqueue(async () => {
            for (const event of events) {
              if (this.#stopped) break;
              await this.#input(event);
            }
          });
        },
        resize: onResize,
        stop: () => this.#stop(),
      });
      this.#draw();
      stopRefresh = watchWorkspaceList(() =>
        this.#enqueue(() => this.#refreshWorkspaces()),
      );
      if (this.#config.updates.check_on_startup) {
        void availableUpdate()
          .then((target) => {
            if (this.#stopped || !target) return;
            this.#update = target;
            if (!this.#receivedInput && this.#mode === "terminal")
              this.#mode = "update";
            this.#draw();
          })
          .catch(() => {});
      }
      await done;
    } finally {
      stopRefresh?.();
      this.#stop();
      this.#client.close();
      unmount?.();
      this.#screen.leave();
    }
    return this.#result;
  }

  #stop(): void {
    this.#stopped = true;
    this.#hostTrial++;
    this.#explorer.leave();
    this.#watcher.stop();
    this.#paneWatches.stop();
    this.#resolveExit?.();
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    this.#jobs = this.#jobs.then(async () => {
      if (this.#stopped) return;
      try {
        await task();
      } catch (error) {
        this.#status = error instanceof Error ? error.message : String(error);
        this.#draw();
        if (this.#client.closed && !this.#stopped) await this.#recoverControl();
      }
    });
    return this.#jobs;
  }

  async #new(current = this.#selected): Promise<NativeWorkspace> {
    const directories =
      current && (await workingDirectories(this.#client, current.id));
    const foreground =
      current?.pid &&
      !current.sshTarget &&
      !this.#host &&
      (!directories?.supportsForegroundSsh ||
        directories.foregroundSsh?.type === "unsupported")
        ? ((await localForegroundSsh(current.pid)) ??
          directories?.foregroundSsh)
        : directories?.foregroundSsh;
    if (!current?.sshTarget && foreground?.type === "unsupported") {
      throw new Error(
        "Use an SSH config alias to open another session with the same options.",
      );
    }
    const target =
      current?.sshTarget ??
      (foreground?.type === "destination" ? foreground.target : undefined);
    const workspace = target
      ? await openSshShell(
          this.#client,
          this.#config,
          this.#layout,
          target,
          current?.sshTarget ? directories?.reported : undefined,
          !this.#host,
        )
      : await createWorkspace(
          this.#client,
          this.#config,
          this.#layout,
          this.#host,
          current,
          current?.backend === "tmux"
            ? directories?.reported
            : directories?.path,
        );
    this.#workspaces.push(workspace);
    return workspace;
  }

  async #select(workspace: NativeWorkspace, render = true): Promise<void> {
    const previous = this.#selected;
    const controls = hasLease(
      await this.#client.request({ type: "attach", session: workspace.id }),
    );
    this.#panes.select(workspace.id, previous?.id);
    if (
      previous &&
      previous.id !== workspace.id &&
      !this.#panes.view(this.#layout).panes.some(({ id }) => id === previous.id)
    )
      await this.#client.request({ type: "detach", session: previous.id });
    this.#watcher.stop();
    this.#selected = workspace;
    this.#controlsInput = controls;
    this.#status = controls ? "" : "Read-only · input held by another client";
    this.#snapshot = decodeSnapshot(
      await this.#client.request({ type: "snapshot", session: workspace.id }),
    );
    if (this.#snapshot.state !== "running") {
      await this.#refreshWorkspaces(workspace.id, render);
      return;
    }
    if (render) this.#draw();
    this.#watcher.start(
      workspace.id,
      this.#snapshot,
      (snapshot) => {
        if (snapshot.state !== "running") {
          void this.#enqueue(() => this.#refreshWorkspaces(workspace.id));
          return;
        }
        this.#snapshot = snapshot;
        this.#draw();
      },
      (error) => {
        this.#status = error instanceof Error ? error.message : String(error);
        this.#draw();
      },
    );
    await this.#resize();
    if (render) this.#draw();
  }

  async #refreshWorkspaces(exitedId?: string, render = true): Promise<void> {
    const running = (await listWorkspaces(this.#client)).filter(
      ({ id, running }) => running && id !== exitedId,
    );
    const selected = this.#selected;
    const previous = this.#workspaces;
    const { workspaces, next } = reconcileWorkspaces(
      previous,
      running,
      selected?.id,
    );
    this.#workspaces = workspaces;
    const runningIds = new Set(workspaces.map(({ id }) => id));
    const closedPanes = this.#panes.ids.filter((id) => !runningIds.has(id));
    for (const id of closedPanes) this.#panes.remove(id);
    if (closedPanes.length) this.#paneDivider = undefined;
    if (
      this.#paneDrag &&
      (closedPanes.length || !runningIds.has(this.#paneDrag.id))
    )
      this.#paneDrag = undefined;
    if (
      this.#renameDraft &&
      !workspaces.some(({ id }) => id === this.#renameDraft?.id)
    ) {
      this.#finishRename();
    }
    if (
      this.#closeTarget &&
      !workspaces.some(({ id }) => id === this.#closeTarget?.id)
    ) {
      this.#closeTarget = undefined;
      this.#mode = "terminal";
    }
    if (selected ? !workspaces.some(({ id }) => id === selected.id) : next) {
      this.#watcher.stop();
      this.#selected = undefined;
      this.#snapshot = undefined;
      this.#controlsInput = false;
      this.#status = "";
      if (this.#mode === "history") this.#mode = "terminal";
      const remaining = this.#panes.ids[0];
      const replacement = workspaces.find(({ id }) => id === remaining) ?? next;
      if (replacement) {
        await this.#select(replacement, render);
        return;
      }
      if (selected) {
        this.#stop();
        return;
      }
    }
    if (closedPanes.length) await this.#resize();
    if (
      render &&
      (previous.length !== workspaces.length ||
        workspaces.some((workspace, index) => workspace !== previous[index]))
    )
      this.#draw();
  }

  async #recoverControl(): Promise<void> {
    const selected = this.#selected;
    for (const wait of [150, 350, 900]) {
      if (this.#stopped) return;
      await delay(wait);
      try {
        const client = await this.#connect();
        if (this.#stopped) {
          client.close();
          return;
        }
        this.#client = client;
        this.#paneWatches.stop();
        if (selected) await this.#select(selected);
        return;
      } catch (error) {
        this.#client.close();
        if (this.#stopped) return;
        this.#status = error instanceof Error ? error.message : String(error);
        this.#draw();
      }
    }
  }

  async #resize(): Promise<void> {
    const panes = this.#panes.view(this.#layout).panes;
    const selected = this.#selected;
    const pane =
      panes.length > 1
        ? panes.find(({ id }) => id === selected?.id)
        : undefined;
    if (this.#controlsInput && selected?.running) {
      const size = pane
        ? paneSize(pane)
        : {
            rows: this.#layout.terminalRows,
            cols: this.#layout.terminalCols,
          };
      await this.#client.request({
        type: "resize",
        session: selected.id,
        ...size,
      });
    }
    await this.#paneWatches.sync(
      this.#client,
      panes,
      selected?.id,
      hasLease,
      (id, snapshot) => {
        if (snapshot.state !== "running") {
          void this.#enqueue(() => this.#refreshWorkspaces(id));
        } else this.#draw();
      },
      (error) => {
        this.#status = error instanceof Error ? error.message : String(error);
        this.#draw();
      },
    );
  }

  async #forward(bytes: Buffer): Promise<void> {
    if (
      !this.#controlsInput ||
      !this.#selected ||
      this.#snapshot?.state !== "running"
    )
      return;
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      await this.#client.sendInput(
        this.#selected.id,
        bytes.subarray(offset, offset + 8192),
      );
    }
  }

  async #input(event: TerminalInput): Promise<void> {
    if (
      this.#paneDrag &&
      event.type === "bytes" &&
      event.bytes.equals(Buffer.from("\x1b"))
    ) {
      this.#paneDrag = undefined;
      this.#draw();
      return;
    }
    if (this.#mode === "rename" && this.#renameDraft) {
      await this.#renameInput(this.#renameDraft, event);
      this.#draw();
      return;
    }
    if (this.#mode === "close") {
      const choice = closeDialogInput(event, this.#screen);
      if (!choice) return;
      const target = this.#closeTarget;
      this.#closeTarget = undefined;
      this.#mode = "terminal";
      if (choice === "close" && target) {
        await this.#client.request({ type: "kill", session: target.id });
        await this.#refreshWorkspaces(target.id);
      }
      this.#draw();
      return;
    }
    if (event.type === "palette") {
      this.#sidebar.cancelDrag();
      this.#paneDrag = undefined;
      this.#paneDivider = undefined;
      if (this.#mode === "palette") this.#mode = "terminal";
      else {
        if (this.#mode === "explorer") this.#explorer.leave();
        if (this.#mode === "hosts") this.#hostTrial++;
        this.#openPalette();
      }
      this.#draw();
      return;
    }
    if (event.type === "mouse") {
      if (this.#mode === "palette") {
        if (event.release && event.button === 0) {
          const line = this.#screen.paletteLineAt(event.row, event.col);
          if (line !== undefined)
            await this.#runPaletteAction(
              this.#palette?.actionAt(line, this.#layout.rows - 2),
            );
          this.#draw();
        }
        return;
      }
      if (this.#mode !== "terminal") return;
      if (await this.#paneMouse(event)) return;
      if (
        event.row === this.#layout.rows &&
        event.col <= paletteShortcut.length + 10 &&
        !event.release &&
        event.button === 0
      ) {
        this.#openPalette();
        this.#draw();
        return;
      }
      const drag = this.#sidebar.mouse(
        event,
        this.#layout.sidebar,
        this.#layout.rows,
        this.#layout.cols,
      );
      if (drag !== "pass") {
        this.#applySidebar();
        if (drag === "resize") await this.#resize();
        return;
      }
      const sidebarCol =
        this.#layout.sidebarSide === "left"
          ? event.col
          : event.col - (this.#layout.cols - this.#layout.sidebar + 1);
      const action =
        !event.release && event.button === 0 && event.row < this.#layout.rows
          ? sidebarActionAt(
              event.row,
              sidebarCol,
              this.#layout.sidebar,
              this.#workspaces,
              this.#selected?.id,
            )
          : undefined;
      if (action?.type === "new") {
        const source =
          action.workspaceIndex === undefined
            ? undefined
            : this.#workspaces[action.workspaceIndex];
        if (action.workspaceIndex !== undefined && !source) return;
        await this.#select(await this.#new(source));
        return;
      }
      if (action?.type === "close") {
        this.#closeTarget = action.workspace;
        this.#mode = "close";
        this.#draw();
        return;
      }
      if (action?.type === "rename") {
        this.#startRename(action.workspace, "terminal");
        this.#draw();
        return;
      }
      if (action?.type === "background") {
        if (this.#selected?.ownership === "managed")
          await this.#pin(this.#selected);
        return;
      }
      if (
        sidebarCol >= 1 &&
        sidebarCol <= this.#layout.sidebar &&
        event.row >= 3 &&
        !event.release &&
        event.button === 0
      ) {
        const workspace = this.#workspaces[event.row - 3];
        if (workspace && sidebarCol === 4 && workspace.ownership === "managed")
          await this.#pin(workspace);
        else if (workspace && sidebarCol <= 2) {
          this.#paneDrag = { id: workspace.id, moved: false };
        } else if (workspace) {
          this.#mode = "terminal";
          await this.#select(workspace);
        }
      } else if (this.#snapshot) {
        const bytes = terminalMouse(event, this.#layout, this.#snapshot.grid);
        if (bytes) await this.#forward(bytes);
      }
      return;
    }
    if (event.type !== "bytes") {
      if (this.#mode === "terminal" && this.#snapshot?.grid.bracketedPaste) {
        await this.#forward(
          Buffer.from(event.type === "paste-start" ? "\x1b[200~" : "\x1b[201~"),
        );
      }
      return;
    }
    if (this.#mode === "terminal") {
      await this.#forward(event.bytes);
      return;
    }
    const key = event.bytes.toString("utf8");
    if (this.#mode === "palette") {
      if (key === "\x1b") this.#mode = "terminal";
      else await this.#runPaletteAction(this.#palette?.input(key));
    } else if (this.#mode === "ssh") {
      await this.#readSshTarget(key);
    } else if (this.#mode === "explorer") {
      if (key === "\x1b") {
        this.#explorer.leave();
        this.#openPalette();
      } else if (key === "\x1b[A") this.#explorer.move(-1);
      else if (key === "\x1b[B") this.#explorer.move(1);
      else if (key === "\r") this.#explorer.activate();
      else if (key === "r") this.#explorer.refresh();
      else if (key === "v") {
        const file = this.#viewableExplorerFile();
        if (file) await openLocalFile(file);
      } else if (key === "o" && this.#explorer.file) {
        if (!this.#explorer.canEdit)
          throw new Error(
            "Open an agent-backed remote workspace to edit this file.",
          );
        await this.#openEditor(this.#explorer.file);
      }
    } else if (this.#mode === "hosts") {
      if (key === "\x1b") {
        this.#hostTrial++;
        this.#openPalette();
        this.#status = "";
      } else if (key === "\x1b[A")
        this.#hostIndex = Math.max(0, this.#hostIndex - 1);
      else if (key === "\x1b[B")
        this.#hostIndex = Math.min(this.#hosts.length - 1, this.#hostIndex + 1);
      else if (key === "\r") this.#switchHost(this.#hosts[this.#hostIndex]);
    } else if (this.#mode === "history") {
      if (key === "\x1b") {
        this.#openPalette();
        this.#history = undefined;
      } else if (key === "\x1b[5~" || key === "\x1b[A")
        await this.#scroll(this.#offset + this.#layout.terminalRows);
      else if (key === "\x1b[6~" || key === "\x1b[B")
        await this.#scroll(
          Math.max(0, this.#offset - this.#layout.terminalRows),
        );
    } else if (this.#mode === "update") {
      if (key === "1") {
        if (this.#update) {
          this.#result = {
            type: "update",
            version: this.#update,
            session: this.#selected?.id,
          };
          this.#stop();
        }
      } else if (key === "2" || key === "\x1b" || key === "3") {
        if (key === "3" && this.#update) {
          await skipUpdate(this.#update);
          this.#update = undefined;
        }
        this.#mode = "terminal";
      }
    } else if (this.#mode === "tmux") {
      if (key === "\x1b") this.#openPalette();
      else if (key === "\x1b[A")
        this.#tmuxIndex = Math.max(0, this.#tmuxIndex - 1);
      else if (key === "\x1b[B")
        this.#tmuxIndex = Math.min(
          Math.max(0, this.#tmux.length - 1),
          this.#tmuxIndex + 1,
        );
      else if (key === "n") await this.#openTmux(null);
      else if (key === "\r" && this.#tmux[this.#tmuxIndex]) {
        await this.#openTmux(this.#tmux[this.#tmuxIndex]?.id ?? null);
      }
    }
    this.#draw();
  }

  async #paneMouse(event: MouseEvent): Promise<boolean> {
    const { row, col, button, release } = event;
    const drag = this.#paneDrag;
    if (drag) {
      if (release && button === 0) {
        this.#paneDrag = undefined;
        const workspace = this.#workspaces.find(({ id }) => id === drag.id);
        if (workspace && drag.moved) {
          const drop = this.#panes.drop(this.#layout, drag.id, row, col);
          if (drop) {
            drop.apply();
            await this.#select(workspace);
          }
        } else if (
          workspace &&
          row === this.#workspaces.indexOf(workspace) + 3
        ) {
          await this.#select(workspace);
        }
        this.#draw();
      } else if ((button & 35) === 32) {
        drag.moved = true;
        const drop = this.#panes.drop(this.#layout, drag.id, row, col);
        if (drop) drag.preview = drop.rect;
        else delete drag.preview;
        this.#draw();
      }
      return true;
    }
    if (this.#paneDivider) {
      if ((release && button === 0) || (button & 35) === 32) {
        this.#panes.resize(this.#paneDivider, row, col);
        if (release) {
          this.#paneDivider = undefined;
          await this.#resize();
        }
        this.#draw();
      }
      return true;
    }
    const { panes, dividers } = this.#panes.view(this.#layout);
    if (panes.length < 2) return false;
    const divider = dividers.find((entry) => contains(entry, row, col));
    if (divider && !release && button === 0) {
      this.#paneDivider = divider;
      return true;
    }
    const pane = panes.find((entry) => contains(entry, row, col));
    if (!pane) return false;
    if (!release && button === 0) {
      if (row === pane.y && col === pane.x + pane.width - 1) {
        this.#panes.remove(pane.id);
        if (pane.id === this.#selected?.id) {
          const next = this.#panes.ids[0];
          const workspace = this.#workspaces.find(({ id }) => id === next);
          if (workspace) await this.#select(workspace);
        } else await this.#resize();
        this.#draw();
        return true;
      }
      if (pane.id !== this.#selected?.id) {
        const workspace = this.#workspaces.find(({ id }) => id === pane.id);
        if (workspace) await this.#select(workspace);
      }
    }
    if (pane.id === this.#selected?.id && this.#snapshot) {
      const bytes = terminalMouse(
        event,
        { contentStart: pane.x - 1 },
        this.#snapshot.grid,
        pane.y,
      );
      if (bytes) await this.#forward(bytes);
    }
    return true;
  }

  #switchHost(host: string | undefined): void {
    if (host === this.#host) {
      this.#mode = "terminal";
      return;
    }
    const trial = ++this.#hostTrial;
    this.#status = `Connecting to ${host ?? "local agent"}…`;
    const attempt = host ? connectRemoteAgent(host) : connectLocalAgent();
    void attempt
      .then((client) => {
        if (trial !== this.#hostTrial || this.#stopped) {
          client.close();
          return;
        }
        this.#result = { type: "host", host, client };
        this.#stop();
      })
      .catch((error: unknown) => {
        if (trial !== this.#hostTrial || this.#stopped) return;
        this.#status = error instanceof Error ? error.message : String(error);
        this.#draw();
      });
  }

  async #pin(selected: NativeWorkspace): Promise<void> {
    const workspace = {
      ...selected,
      ...decodeWorkspace(
        await this.#client.request({
          type: "pin",
          session: selected.id,
          persistent: !selected.persistent,
        }),
      ),
    };
    this.#workspaces = this.#workspaces.map((entry) =>
      entry.id === workspace.id ? workspace : entry,
    );
    if (this.#selected?.id === workspace.id) this.#selected = workspace;
    this.#draw();
  }

  #startRename(
    workspace: NativeWorkspace,
    returnTo: RenameDraft["returnTo"],
  ): void {
    this.#renameDraft = {
      id: workspace.id,
      name: workspace.name,
      replace: true,
      returnTo,
    };
    this.#mode = "rename";
  }

  async #renameInput(draft: RenameDraft, event: TerminalInput): Promise<void> {
    if (event.type === "mouse" && event.button === 0 && event.release) {
      const line = this.#screen.paletteLineAt(event.row, event.col);
      if (line === 2) this.#finishRename();
      if (line === 3 && draft.name.trim()) await this.#rename(draft);
    }
    if (event.type !== "bytes") return;
    const key = event.bytes.toString("utf8");
    if (key === "\x1b") this.#finishRename();
    else if (key === "\r") {
      if (draft.name.trim()) await this.#rename(draft);
    } else if (key === "\x01") {
      draft.replace = true;
    } else if (key === "\x7f") {
      draft.name = draft.replace ? "" : [...draft.name].slice(0, -1).join("");
      draft.replace = false;
    } else if (!/\p{Cc}/u.test(key)) {
      const name = draft.replace ? key : draft.name + key;
      if (Buffer.byteLength(name) <= 128) {
        draft.name = name;
        draft.replace = false;
      }
    }
  }

  #finishRename(): void {
    const returnTo = this.#renameDraft?.returnTo;
    this.#renameDraft = undefined;
    if (returnTo === "palette") this.#openPalette();
    else this.#mode = "terminal";
  }

  async #rename(draft: { id: string; name: string }): Promise<void> {
    const workspace = this.#workspaces.find(({ id }) => id === draft.id);
    if (!workspace) return;
    const renamed = {
      ...workspace,
      ...decodeWorkspace(
        await this.#client.request({
          type: "rename",
          session: draft.id,
          name: draft.name,
        }),
      ),
    };
    this.#workspaces = this.#workspaces.map((workspace) =>
      workspace.id === renamed.id ? renamed : workspace,
    );
    if (this.#selected?.id === renamed.id) this.#selected = renamed;
    this.#finishRename();
  }

  async #scroll(offset: number): Promise<void> {
    if (!this.#selected) return;
    const data = await this.#client.request({
      type: "scroll",
      session: this.#selected.id,
      offset,
    });
    if (
      typeof data !== "object" ||
      data === null ||
      !("scrollback" in data) ||
      typeof data.scrollback !== "number"
    ) {
      throw new Error("Invalid scrollback response");
    }
    this.#history = decodeSnapshot(data);
    this.#offset = data.scrollback;
  }

  async #openTmux(
    target: string | null,
    cwd = this.#selected?.cwd ?? "~",
  ): Promise<void> {
    const opened = await openTmux(this.#client, this.#layout, cwd, target);
    if (!this.#workspaces.some(({ id }) => id === opened.id))
      this.#workspaces.push(opened);
    await this.#select(opened);
    this.#mode = "terminal";
  }

  async #openEditor(path: string): Promise<void> {
    const editor = this.#config.explorer.editor;
    const workspace = decodeWorkspace(
      await this.#client.request({
        type: "create",
        name: `Edit ${posix.basename(path).replace(/\p{Cc}/gu, "")}`,
        cwd: posix.dirname(path),
        command: editor.command,
        args: [...editor.args, path],
        rows: this.#layout.terminalRows,
        cols: this.#layout.terminalCols,
        persistent: false,
      }),
    );
    this.#workspaces.push(workspace);
    this.#explorer.leave();
    await this.#select(workspace);
    this.#mode = "terminal";
  }

  async #runAction(key: string): Promise<void> {
    if (key === "d") {
      await this.#exit("keep-all");
    } else if (key === "q" || key === "Q") {
      const policy = this.#config.defaults.on_exit;
      await this.#exit(policy === "ask" ? "keep-all" : policy);
    } else if (key === "r" && this.#selected) {
      this.#startRename(this.#selected, "palette");
    } else if (key === "s" && this.#selected) {
      await this.#scroll(this.#layout.terminalRows);
      this.#mode = "history";
    } else if (key === "u") {
      await this.#checkForUpdate();
    } else if (key === "b" || key === "m") {
      if (key === "b") this.#sidebar.toggle();
      else this.#sidebar.flip();
      this.#applySidebar();
      await this.#resize();
      this.#mode = "terminal";
    } else if (key === "t") {
      const inventory = await listTmux(this.#client);
      if (!inventory.available)
        throw new Error("tmux is unavailable on this host");
      this.#tmux = inventory.sessions;
      this.#tmuxIndex = 0;
      this.#mode = "tmux";
    } else if (key === "e") {
      const directory = await workspaceDirectory(
        this.#client,
        this.#selected,
        this.#connect,
        this.#host,
      );
      this.#mode = "explorer";
      this.#explorer.enter(
        directory.path,
        directory.connect,
        directory.canEdit,
      );
    } else if (key === "n") {
      const workspace = await this.#new();
      this.#mode = "terminal";
      await this.#select(workspace);
    } else if (key === "c") {
      this.#sshTarget = "";
      this.#mode = "ssh";
    } else if (key === "h") {
      this.#hosts = [
        undefined,
        ...new Set(
          this.#config.workspaces.flatMap(({ host }) => (host ? [host] : [])),
        ),
      ];
      this.#hostIndex = Math.max(0, this.#hosts.indexOf(this.#host));
      this.#mode = "hosts";
    } else if (key === "p" && this.#selected) {
      await this.#pin(this.#selected);
      this.#mode = "terminal";
    }
  }

  async #runPaletteAction(action: PaletteAction | undefined): Promise<void> {
    if (action?.kind === "workspace") {
      const workspace = this.#workspaces.find(({ id }) => id === action.id);
      if (workspace) {
        this.#mode = "terminal";
        await this.#select(workspace);
      }
    } else if (action?.kind === "command") {
      await this.#runAction(action.key);
    }
  }

  #openPalette(): void {
    this.#renameDraft = undefined;
    this.#palette = new CommandPalette(
      this.#workspaces,
      this.#selected?.id,
      this.#update,
      this.#layout.sidebar > 0,
      this.#sidebar.side,
    );
    this.#mode = "palette";
  }

  #applySidebar(): void {
    this.#layout = geometry(
      this.#layout.rows,
      this.#layout.cols,
      this.#sidebar.preferred,
      this.#sidebar.side,
    );
    this.#draw();
  }

  async #checkForUpdate(): Promise<void> {
    if (!this.#update) {
      this.#status = "Checking for updates…";
      this.#draw();
      this.#update = await availableUpdate(true);
    }
    if (this.#stopped) return;
    this.#status = this.#update ? "" : "No newer stable release found";
    if (this.#update) this.#mode = "update";
  }

  async #readSshTarget(key: string): Promise<void> {
    if (key === "\x1b") this.#openPalette();
    else if (key === "\x7f") this.#sshTarget = this.#sshTarget.slice(0, -1);
    else if (key === "\r") {
      const workspace = await openSshShell(
        this.#client,
        this.#config,
        this.#layout,
        this.#sshTarget,
        undefined,
        !this.#host,
      );
      this.#workspaces.push(workspace);
      this.#mode = "terminal";
      await this.#select(workspace);
    } else if (/^[a-zA-Z0-9_.:@-]+$/u.test(key))
      this.#sshTarget = (this.#sshTarget + key).slice(0, 128);
  }

  async #exit(policy: ExitPolicy): Promise<void> {
    if (policy !== "keep-all") {
      for (const workspace of await listWorkspaces(this.#client)) {
        if (
          workspace.ownership === "managed" &&
          workspace.running &&
          (policy === "terminate" || !workspace.persistent)
        ) {
          await this.#client.request({ type: "kill", session: workspace.id });
        }
      }
    }
    this.#stop();
  }

  #draw(): void {
    if (this.#stopped) return;
    const rows = this.#layout.rows - 2;
    const screen = workspaceScreen({
      config: this.#config,
      mode: this.#mode,
      host: this.#host,
      status: this.#status,
      update: this.#update,
      layout: this.#layout,
      resizingSidebar: this.#sidebar.dragging,
      selected: this.#selected,
      workspaces: this.#workspaces,
      snapshot: this.#snapshot,
      history: this.#history,
      controlsInput: this.#controlsInput,
      explorer:
        this.#mode === "explorer" ? this.#explorer.layout(rows) : undefined,
      canOpenExplorerFile:
        this.#mode === "explorer" && this.#viewableExplorerFile() !== undefined,
      hosts: this.#hosts,
      hostIndex: this.#hostIndex,
      tmux: this.#tmux,
      tmuxIndex: this.#tmuxIndex,
      renameName: this.#renameDraft?.name,
      offset: this.#offset,
      sshTarget: this.#sshTarget,
      closeTarget: this.#closeTarget,
      paletteLines:
        this.#mode === "palette" ? this.#palette?.lines(rows) : undefined,
    });
    if (this.#mode === "terminal") {
      const { panes, dividers } = this.#panes.view(this.#layout);
      if (panes.length > 1) {
        screen.panes = panes.map((pane) => ({
          pane,
          name: this.#workspaces.find(({ id }) => id === pane.id)?.name ?? "",
          snapshot:
            pane.id === this.#selected?.id
              ? this.#snapshot
              : this.#paneWatches.snapshot(pane.id),
          focused: pane.id === this.#selected?.id,
        }));
        screen.dividers = dividers;
      }
      if (this.#paneDrag?.preview) screen.dropPreview = this.#paneDrag.preview;
    }
    this.#screen.draw(screen);
  }

  #viewableExplorerFile(): string | undefined {
    if (this.#host || this.#selected?.sshTarget) return undefined;
    const file = this.#explorer.file;
    return file && isViewableFile(file) ? file : undefined;
  }
}
