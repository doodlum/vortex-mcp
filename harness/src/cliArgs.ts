/**
 * The `vortex-ai` command line, parsed. Kept apart from cli.ts so the rules that agents keep
 * tripping over (where `--owner` may go, what `--` means) have unit tests.
 */
import { ConfigError } from "./config";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Every value of each string flag, for flags that may repeat (`--test a --test b`). */
  lists: Record<string, string[]>;
  /** Everything after a bare `--` (the command for `lease run`), or a script's own arguments. */
  passthrough: string[];
}

export const BOOLEAN_FLAGS = new Set([
  "help",
  "installed",
  "sandbox",
  "bethesda-sandbox",
  "isolate-user-folders",
  "headless",
  "production",
  "oauth",
  "no-wait",
  "no-launch",
  "fresh",
  "no-game",
  "rebuild-snapshot",
  "rebuild-extension",
  "json",
  "screenshots",
  "strict",
  "build",
  "update",
  "no-build",
  "where",
  "purge",
  "keep",
  "full-page",
  "allow-incomplete",
  "skip-revert",
  "force",
  "with-api-key",
  "checkout-only",
]);

/**
 * Flags `script` takes for itself wherever they appear, even after the script's path: agents
 * put `--owner` last as often as first, and a script run as the wrong owner is refused the
 * lease. Everything else after the path is the script's; after a bare `--`, all of it is.
 */
export const SCRIPT_KIT_FLAGS = new Set(["owner", "wait"]);

export function parseArgs(argv: string[]): ParsedArgs {
  // `pnpm run ai -- status` forwards the `--` separator itself, so the first
  // argument we see is "--" rather than the command. Dropping a leading bare
  // separator makes the documented invocation work instead of printing help.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command = "help", ...rest] = args;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const lists: Record<string, string[]> = {};
  const setValue = (name: string, value: string): void => {
    flags[name] = value;
    (lists[name] ??= []).push(value);
  };

  const passthrough: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    const next = rest[i + 1];
    // `script <file> [args...]`: after the file, only the kit's own flags are taken.
    if (command === "script" && positional.length === 1) {
      if (arg === "--") {
        passthrough.push(...rest.slice(i + 1));
        break;
      }
      const kitFlag = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
      if (kitFlag?.[1] !== undefined && SCRIPT_KIT_FLAGS.has(kitFlag[1])) {
        if (kitFlag[2] !== undefined) {
          setValue(kitFlag[1], kitFlag[2]);
        } else if (next !== undefined && !next.startsWith("--")) {
          setValue(kitFlag[1], next);
          i++;
        } else {
          throw new ConfigError(`--${kitFlag[1]} needs a value.`);
        }
        continue;
      }
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      // `pnpm run ai:<script> -- --flag` forwards its separator after the command; only
      // `lease run` gives it a meaning.
      if (command !== "lease" || positional[0] !== "run") continue;
      passthrough.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      // `lease run [flags] <command...>`: the command starts at its first word even without
      // `--`, which Windows PowerShell 5.1 strips from native command lines.
      if (command === "lease" && positional.length === 1 && positional[0] === "run") {
        passthrough.push(...rest.slice(i));
        break;
      }
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      setValue(body.slice(0, eq), body.slice(eq + 1));
    } else if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
    } else if (next !== undefined && !next.startsWith("--")) {
      setValue(body, next);
      i++;
    } else {
      throw new ConfigError(`--${body} needs a value. Run help for supported flags.`);
    }
  }
  return { command, positional, flags, lists, passthrough };
}
