import { posix } from "node:path";
import { availableUpdate, skipUpdate } from "../release/updates.js";
import { restartAfterUpdate } from "../release/restart.js";
import { Explorer } from "../explorer/explorer.js";
import { setTimeout as delay } from "node:timers/promises";
import { connectRemoteAgent } from "../agent/ssh.js";
import { connectLocalAgent } from "../agent/local.js";
import type { Config, WorkspaceConfig } from "../config/schema.js";
import type { SessionClient } from "../protocol/client.js";
import type { TerminalInput } from "./input.js";
import { mountRawInput } from "./raw-input.js";
import { CommandPalette } from "./palette.js";
import { sidebarActionAt } from "./sidebar-actions.js";
import { openSshShell } from "./ssh-shell.js";
import type { Mode } from "./view.js";
import { workspaceScreen } from "./workspace-screen.js";
import { listTmux, openTmux, type TmuxTarget } from "./tmux.js";
import { TerminalWatch } from "./watch.js";
import { watchWorkspaceList } from "./workspace-refresh.js";
import { terminalMouse } from "./mouse.js";
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
  readonly #explorer: Explorer;
  #layout = geometry(process.stdout.rows || 24, process.stdout.columns || 80);
  #mode: Mode = "terminal";
  #status = "";
  #update: string | undefined;
  #result: WorkspaceResult | undefined;
  #hosts: (string | undefined)[] = [];
  #hostIndex = 0;
  #newEntries: WorkspaceConfig[] = [];
  #newIndex = 0;
  #hostTrial = 0;
  #history: TerminalSnapshot | undefined;
  #offset = 0;
  #name = "";
  #command = "";
  #commandError = false;
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
        );
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
      unmount = mountRawInput(this.#config.terminal.prefix_key, {
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

  async #new(requested?: WorkspaceConfig): Promise<NativeWorkspace> {
    const workspace = await createWorkspace(
      this.#client,
      this.#config,
      this.#layout,
      this.#host,
      requested,
    );
    this.#workspaces.push(workspace);
    return workspace;
  }

  async #select(workspace: NativeWorkspace, render = true): Promise<void> {
    const previous = this.#selected;
    const controls = hasLease(
      await this.#client.request({ type: "attach", session: workspace.id }),
    );
    if (previous && previous.id !== workspace.id)
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
    if (selected ? !workspaces.some(({ id }) => id === selected.id) : next) {
      this.#watcher.stop();
      this.#selected = undefined;
      this.#snapshot = undefined;
      this.#controlsInput = false;
      this.#status = "";
      if (this.#mode === "history") this.#mode = "terminal";
      if (next) {
        await this.#select(next, render);
        return;
      }
    }
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
    if (!this.#controlsInput || !this.#selected?.running) return;
    await this.#client.request({
      type: "resize",
      session: this.#selected.id,
      rows: this.#layout.terminalRows,
      cols: this.#layout.terminalCols,
    });
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
    if (event.type === "palette") {
      if (this.#mode === "terminal" || this.#mode === "menu")
        this.#openPalette();
      else if (this.#mode === "palette") this.#mode = "terminal";
      this.#draw();
      return;
    }
    if (event.type === "prefix") {
      if (this.#mode === "explorer") this.#explorer.leave();
      if (this.#mode === "hosts") this.#hostTrial++;
      this.#mode = this.#mode === "terminal" ? "menu" : "terminal";
      this.#draw();
      return;
    }
    if (event.type === "mouse") {
      if (this.#mode !== "terminal" && this.#mode !== "menu") return;
      if (
        event.col <= this.#layout.sidebar &&
        event.row >= 3 &&
        !event.release &&
        event.button === 0
      ) {
        const action = sidebarActionAt(event.row, this.#layout.rows - 2);
        const workspace = this.#workspaces[event.row - 3];
        if (action) {
          await this.#menu(action);
          this.#draw();
        } else if (
          workspace &&
          event.col === 4 &&
          workspace.ownership === "managed"
        )
          await this.#pin(workspace);
        else if (workspace) await this.#select(workspace);
      } else if (this.#mode === "terminal" && this.#snapshot) {
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
      else {
        const action = this.#palette?.input(key);
        if (action) {
          this.#mode = "menu";
          await this.#menu(action);
        }
      }
    } else if (this.#mode === "ssh") {
      await this.#readSshTarget(key);
    } else if (this.#mode === "explorer") {
      if (key === "\x1b") {
        this.#explorer.leave();
        this.#mode = "menu";
      } else if (key === "\x1b[A") this.#explorer.move(-1);
      else if (key === "\x1b[B") this.#explorer.move(1);
      else if (key === "\r") this.#explorer.activate();
      else if (key === "r") this.#explorer.refresh();
      else if (key === "o" && this.#explorer.file)
        await this.#openEditor(this.#explorer.file);
    } else if (this.#mode === "create") {
      if (key === "\x1b") this.#mode = "menu";
      else if (key === "\x1b[A")
        this.#newIndex = Math.max(0, this.#newIndex - 1);
      else if (key === "\x1b[B")
        this.#newIndex = Math.min(this.#newEntries.length, this.#newIndex + 1);
      else if (key === "\r") {
        const requested = this.#newEntries[this.#newIndex - 1];
        if (requested?.backend === "tmux") {
          await this.#openTmux(requested.session ?? null, requested.cwd);
        } else {
          await this.#select(await this.#new(requested));
          this.#mode = "terminal";
        }
      }
    } else if (this.#mode === "hosts") {
      if (key === "\x1b") {
        this.#hostTrial++;
        this.#mode = "menu";
        this.#status = "";
      } else if (key === "\x1b[A")
        this.#hostIndex = Math.max(0, this.#hostIndex - 1);
      else if (key === "\x1b[B")
        this.#hostIndex = Math.min(this.#hosts.length - 1, this.#hostIndex + 1);
      else if (key === "\r") this.#switchHost(this.#hosts[this.#hostIndex]);
    } else if (this.#mode === "history") {
      if (key === "\x1b") {
        this.#mode = "menu";
        this.#history = undefined;
      } else if (key === "\x1b[5~" || key === "\x1b[A")
        await this.#scroll(this.#offset + this.#layout.terminalRows);
      else if (key === "\x1b[6~" || key === "\x1b[B")
        await this.#scroll(
          Math.max(0, this.#offset - this.#layout.terminalRows),
        );
    } else if (this.#mode === "rename") {
      if (key === "\x1b") this.#mode = "menu";
      else if (key === "\x7f")
        this.#name = [...this.#name].slice(0, -1).join("");
      else if (key === "\r") await this.#rename();
      else if (
        !/\p{Cc}/u.test(key) &&
        Buffer.byteLength(this.#name + key) <= 128
      )
        this.#name += key;
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
      if (key === "\x1b") this.#mode = "menu";
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
    } else if (this.#mode === "command") {
      await this.#readCommand(key);
    } else if (this.#mode === "exit") {
      if (key === "1" || key === "\r") await this.#exit("keep-all");
      if (key === "2") await this.#exit("keep-pinned");
      if (key === "3") await this.#exit("terminate");
      if (key === "\x1b" || key === "4") this.#mode = "menu";
    } else {
      await this.#menu(key);
    }
    this.#draw();
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
    const workspace = decodeWorkspace(
      await this.#client.request({
        type: "pin",
        session: selected.id,
        persistent: !selected.persistent,
      }),
    );
    this.#workspaces = this.#workspaces.map((entry) =>
      entry.id === workspace.id ? workspace : entry,
    );
    if (this.#selected?.id === workspace.id) this.#selected = workspace;
    this.#draw();
  }

  async #rename(): Promise<void> {
    if (!this.#selected) return;
    const renamed = decodeWorkspace(
      await this.#client.request({
        type: "rename",
        session: this.#selected.id,
        name: this.#name,
      }),
    );
    this.#workspaces = this.#workspaces.map((workspace) =>
      workspace.id === renamed.id ? renamed : workspace,
    );
    this.#selected = renamed;
    this.#mode = "menu";
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

  async #menu(key: string): Promise<void> {
    if (key === "\x1b") {
      this.#mode = "terminal";
    } else if (key === " ") {
      this.#openPalette();
    } else if (key.startsWith("/")) {
      this.#command = "";
      this.#commandError = false;
      this.#mode = "command";
      await this.#readCommand(key.slice(1));
    } else if (key === "d") {
      await this.#exit("keep-all");
    } else if (key === "q" || key === "Q") {
      await this.#requestExit();
    } else if (key === "r" && this.#selected) {
      this.#name = "";
      this.#mode = "rename";
    } else if (key === "s" && this.#selected) {
      await this.#scroll(this.#layout.terminalRows);
      this.#mode = "history";
    } else if (key === "u") {
      await this.#checkForUpdate();
    } else if (key === "t") {
      const inventory = await listTmux(this.#client);
      if (!inventory.available)
        throw new Error("tmux is unavailable on this host");
      this.#tmux = inventory.sessions;
      this.#tmuxIndex = 0;
      this.#mode = "tmux";
    } else if (key === "e") {
      this.#mode = "explorer";
      this.#explorer.enter(this.#selected?.cwd ?? "~");
    } else if (key === "n") {
      this.#newEntries = this.#config.workspaces.filter(
        ({ host }) => host === this.#host,
      );
      this.#newIndex = 0;
      this.#mode = "create";
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
    } else {
      const current = this.#workspaces.findIndex(
        ({ id }) => id === this.#selected?.id,
      );
      const index = /^[1-9]$/u.test(key)
        ? Number(key) - 1
        : key === "\x1b[A"
          ? Math.max(0, current - 1)
          : key === "\x1b[B"
            ? current + 1
            : -1;
      const next = this.#workspaces[index];
      if (next) {
        await this.#select(next);
        this.#mode = "terminal";
      }
    }
  }

  #openPalette(): void {
    this.#palette = new CommandPalette(Boolean(this.#selected), this.#update);
    this.#mode = "palette";
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
    if (key === "\x1b") this.#mode = "menu";
    else if (key === "\x7f") this.#sshTarget = this.#sshTarget.slice(0, -1);
    else if (key === "\r") {
      const workspace = await openSshShell(
        this.#client,
        this.#config,
        this.#layout,
        this.#sshTarget,
      );
      this.#workspaces.push(workspace);
      this.#mode = "terminal";
      await this.#select(workspace);
    } else if (/^[a-zA-Z0-9_.:@-]+$/u.test(key))
      this.#sshTarget = (this.#sshTarget + key).slice(0, 128);
  }

  async #readCommand(input: string): Promise<void> {
    if (input === "\x1b") {
      this.#mode = "menu";
      return;
    }
    const [text = "", submitted] = input.split(/(\r|\n)/u, 2);
    if (!/^[a-zA-Z\x7f]*$/u.test(text)) return;
    for (const character of text.slice(0, 32)) {
      if (character === "\x7f") this.#command = this.#command.slice(0, -1);
      else if (this.#command.length < 24) this.#command += character;
    }
    if (text) this.#commandError = false;
    if (!submitted) return;
    if (this.#command.toLowerCase() === "exit") await this.#requestExit();
    else this.#commandError = true;
  }

  async #requestExit(): Promise<void> {
    const policy = this.#config.defaults.on_exit;
    if (policy === "ask") this.#mode = "exit";
    else await this.#exit(policy);
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
    this.#screen.draw(
      workspaceScreen({
        config: this.#config,
        mode: this.#mode,
        host: this.#host,
        status: this.#status,
        update: this.#update,
        layout: this.#layout,
        selected: this.#selected,
        workspaces: this.#workspaces,
        snapshot: this.#snapshot,
        history: this.#history,
        controlsInput: this.#controlsInput,
        explorer:
          this.#mode === "explorer" ? this.#explorer.layout(rows) : undefined,
        newEntries: this.#newEntries,
        newIndex: this.#newIndex,
        hosts: this.#hosts,
        hostIndex: this.#hostIndex,
        tmux: this.#tmux,
        tmuxIndex: this.#tmuxIndex,
        name: this.#name,
        offset: this.#offset,
        command: this.#command,
        commandError: this.#commandError,
        sshTarget: this.#sshTarget,
        paletteLines:
          this.#mode === "palette" ? this.#palette?.lines(rows) : undefined,
      }),
    );
  }
}
