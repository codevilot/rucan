import { quoteSshScript } from "./ssh-reconnect.js";

const reportDirectory = [
  "_rucan_report_directory() {",
  '  [ "${_rucan_last_directory-}" != "$PWD" ] || return 0',
  "  _rucan_last_directory=$PWD",
  '  [ "${#PWD}" -le 1300 ] || return 0',
  String.raw`  _rucan_uri=$(printf '%s' "$PWD" | LC_ALL=C od -An -v -tx1 |`,
  String.raw`    LC_ALL=C awk '{ for (i = 1; i <= NF; i++) printf ($i == "2f" ? "/" : "%%%s"), $i }')`,
  '  [ "${#_rucan_uri}" -le 4096 ] || return 0',
  "  case $_rucan_uri in",
  String.raw`    /*) printf '\033]7;file://%s\007' "$_rucan_uri" ;;`,
  "  esac",
  "}",
].join("\n");

const bashLogin = [
  "if [ -r /etc/profile ]; then . /etc/profile; fi",
  "for file in ~/.bash_profile ~/.bash_login ~/.profile; do",
  '  if [ -r "$file" ]; then . "$file"; break; fi',
  "done",
].join("\n");

function bashStartup(login: boolean): string {
  return [
    'rm -f -- "$RUCAN_SSH_RC"',
    "unset RUCAN_SSH_RC",
    login ? bashLogin : "if [ -r ~/.bashrc ]; then . ~/.bashrc; fi",
    reportDirectory,
    'if [ "${BASH_VERSINFO[0]}" -ge 5 ]; then',
    "  PROMPT_COMMAND+=('_rucan_report_directory')",
    "else",
    '  PROMPT_COMMAND="$PROMPT_COMMAND\n_rucan_report_directory"',
    "fi",
  ].join("\n");
}

export function sshShellCommand(directory: string | undefined): string {
  const script = [
    ...(directory ? ["cd " + quoteSshScript(directory) + " || :"] : []),
    "shell=${SHELL:-/bin/sh}",
    'case "$shell" in',
    "  */bash)",
    '    if RUCAN_SSH_RC=$(mktemp "${TMPDIR:-/tmp}/rucan-ssh.XXXXXXXX"); then',
    "      if printf '%s' " +
      quoteSshScript(bashStartup(directory === undefined)) +
      ' > "$RUCAN_SSH_RC"; then',
    "        export RUCAN_SSH_RC",
    '        exec "$shell" --rcfile "$RUCAN_SSH_RC" -i',
    "      fi",
    '      rm -f -- "$RUCAN_SSH_RC"',
    "    fi",
    "    ;;",
    "esac",
    reportDirectory,
    "_rucan_report_directory",
    directory ? 'exec "$shell" -i' : 'exec "$shell" -il',
  ].join("\n");
  return "sh -c " + quoteSshScript(script);
}
