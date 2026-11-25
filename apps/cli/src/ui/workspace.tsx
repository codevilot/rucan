import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useState, type ReactElement } from "react";
import type { Config } from "../config/schema.js";

const fixtureExplorer = ["▾ example-project", "  ▸ src", "    README.md"];

export function WorkspaceView({ config }: { config: Config }): ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const [menu, setMenu] = useState(false);
  const workspace = config.workspaces[selected];
  const prefix = config.terminal.prefix_key;
  useInput((input, key) => {
    if (key.ctrl && input === prefix.slice(-1)) {
      setMenu((open) => !open);
      return;
    }
    if (key.escape && menu) {
      setMenu(false);
      return;
    }
    if (!key.ctrl && !key.meta && input === "q") {
      exit();
      return;
    }
    if (menu || config.workspaces.length === 0) return;
    if (key.upArrow || key.downArrow) {
      const step = key.upArrow ? -1 : 1;
      setSelected((index) =>
        Math.max(0, Math.min(index + step, config.workspaces.length - 1)),
      );
    } else if (
      !key.ctrl &&
      !key.meta &&
      /^[1-9]$/.test(input) &&
      Number(input) <= config.workspaces.length
    ) {
      setSelected(Number(input) - 1);
    }
  });

  if (columns < 48 || rows < 12) {
    return <Text>Resize to at least 48×12. Q quits.</Text>;
  }

  const maxVisible = Math.max(1, rows - 11);
  const start = Math.max(0, selected - maxVisible + 1);
  const sidebarWidth = Math.max(16, Math.floor(columns * 0.25));
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold color="cyan">
          rucan
        </Text>
        <Text color="yellow">Fixture mode · agent offline</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Box width={sidebarWidth} flexShrink={0} flexDirection="column">
          <Box borderStyle="single" flexDirection="column" flexGrow={1}>
            <Text bold>WORKSPACES</Text>
            {config.workspaces.length === 0 && (
              <Text dimColor>No workspaces</Text>
            )}
            {config.workspaces
              .slice(start, start + maxVisible)
              .map((entry, index) => (
                <Text
                  key={entry.name}
                  wrap="truncate-end"
                  {...(start + index === selected ? { color: "cyan" } : {})}
                >
                  {start + index === selected ? "›" : " "} {entry.name}
                  {entry.persistence === "persistent" ? " ◆" : ""}
                </Text>
              ))}
          </Box>
          <Box borderStyle="single" flexDirection="column">
            <Text bold>EXPLORER</Text>
            {fixtureExplorer.map((item) => (
              <Text key={item} wrap="truncate-end" dimColor>
                {item}
              </Text>
            ))}
          </Box>
        </Box>
        <Box
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          borderStyle="single"
          flexDirection="column"
          paddingX={1}
        >
          <Text bold>{menu ? "MENU" : "TERMINAL"}</Text>
          {menu ? (
            <Text>Esc closes the menu. Q quits.</Text>
          ) : (
            <>
              {workspace && (
                <Text wrap="truncate-end">
                  {workspace.host ?? "local"} · {workspace.backend} ·{" "}
                  {workspace.persistence}
                </Text>
              )}
              {workspace && (
                <Text wrap="truncate-end" color="green">
                  {workspace.cwd} $ {workspace.command}
                </Text>
              )}
              <Text wrap="truncate-end" dimColor>
                Fixture preview. No shell is running.
              </Text>
            </>
          )}
        </Box>
      </Box>
      <Text wrap="truncate-end" dimColor>
        {prefix} Menu · ↑↓ / 1–9 Switch · Q Quit
      </Text>
    </Box>
  );
}
