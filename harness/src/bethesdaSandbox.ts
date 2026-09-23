/**
 * A fake Fallout 4 for testing Vortex's Bethesda-game support without the game.
 *
 * Plugins, LOOT sorting and the Missing Masters check only exist for Bethesda games,
 * and the generic sandbox game has none of them. This builds a disposable game
 * directory that Vortex's own Fallout 4 support accepts. It holds a stand-in
 * executable and generated plugin files with real TES4 headers, so masters parse.
 *
 * A Bethesda game also writes outside its directory: plugins.txt under LocalAppData,
 * and INI files, INI backups and per-profile INI copies under Documents\My Games. So
 * the sandbox has private copies of both, and the instance is started with Vortex
 * redirected to them (see buildInstanceEnv and mainPreload.ts). The operator's real
 * game and profile files are never read or written.
 */
import fs from "node:fs";
import path from "node:path";

import type { HarnessConfig } from "./config";

export interface PluginSpec {
  /** Filename, e.g. "A.esp". */
  name: string;
  /** Plugin filenames this one depends on, in order. */
  masters?: string[];
  /** Set the ESM flag. Implied for a `.esm`. */
  master?: boolean;
  /** Set the ESL (light) flag. Implied for a `.esl`. */
  light?: boolean;
  author?: string;
}

const MASTER_FLAG = 0x1;
const LIGHT_FLAG = 0x200;

function subrecord(tag: string, data: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.write(tag, 0, 4, "ascii");
  header.writeUInt16LE(data.length, 4);
  return Buffer.concat([header, data]);
}

const zstring = (value: string): Buffer => Buffer.from(`${value}\0`, "latin1");

/**
 * The bytes of a plugin holding only its TES4 header record, which is all Vortex's
 * header reader and LOOT need to know its flags and masters.
 *
 * Layout: a 24-byte record header (`TES4`, data size, flags, form id, version
 * control, form version, unknown), then subrecords of `tag[4] size[2] data`. HEDR
 * is version, record count and next object id; a record count of 0 would mark the
 * plugin as a dummy. Each MAST is followed by an 8-byte DATA, as the game writes it.
 */
export function pluginBytes(spec: PluginSpec): Buffer {
  const ext = path.extname(spec.name).toLowerCase();
  let flags = 0;
  if (spec.master === true || ext === ".esm") flags |= MASTER_FLAG;
  if (spec.light === true || ext === ".esl") flags |= LIGHT_FLAG | MASTER_FLAG;

  const hedr = Buffer.alloc(12);
  hedr.writeFloatLE(1.0, 0);
  hedr.writeUInt32LE(1, 4);
  hedr.writeUInt32LE(0x800, 8);
  const parts = [subrecord("HEDR", hedr), subrecord("CNAM", zstring(spec.author ?? "vortex-mcp"))];
  for (const master of spec.masters ?? []) {
    parts.push(subrecord("MAST", zstring(master)), subrecord("DATA", Buffer.alloc(8)));
  }
  const data = Buffer.concat(parts);

  const header = Buffer.alloc(24);
  header.write("TES4", 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  header.writeUInt32LE(flags, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt16LE(131, 20); // Fallout 4's form version
  header.writeUInt16LE(0, 22);
  return Buffer.concat([header, data]);
}

export function writePlugin(dir: string, spec: PluginSpec): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, spec.name);
  fs.writeFileSync(file, pluginBytes(spec));
  return file;
}

export interface BethesdaSandbox {
  gameId: "fallout4";
  gamePath: string;
  dataPath: string;
  localAppData: string;
  documents: string;
  /** Where Fallout 4's plugins.txt lives inside the sandbox. */
  pluginsTxt: string;
  /** Where Fallout 4's INI files live inside the sandbox. */
  myGames: string;
}

/** The sandbox's layout, without creating anything. */
export function bethesdaSandboxPaths(cacheDir: string): BethesdaSandbox {
  const root = path.join(cacheDir, "bethesda-sandbox", "fallout4");
  const gamePath = path.join(root, "game");
  const localAppData = path.join(root, "Local");
  const documents = path.join(root, "Documents");
  return {
    gameId: "fallout4",
    gamePath,
    dataPath: path.join(gamePath, "Data"),
    localAppData,
    documents,
    pluginsTxt: path.join(localAppData, "Fallout4", "plugins.txt"),
    myGames: path.join(documents, "My Games", "Fallout4"),
  };
}

const INI_FILES = ["Fallout4.ini", "Fallout4Prefs.ini", "Fallout4Custom.ini"];

/**
 * Create the fake game and its private profile folders. Idempotent: an existing file is
 * left alone, so mods deployed into it and settings Vortex wrote survive a restart.
 */
export function ensureBethesdaSandbox(cacheDir: string): BethesdaSandbox {
  const sandbox = bethesdaSandboxPaths(cacheDir);
  fs.mkdirSync(sandbox.dataPath, { recursive: true });
  fs.mkdirSync(path.dirname(sandbox.pluginsTxt), { recursive: true });
  fs.mkdirSync(sandbox.myGames, { recursive: true });

  const exe = path.join(sandbox.gamePath, "Fallout4.exe");
  if (!fs.existsSync(exe)) fs.writeFileSync(exe, "Vortex automation fixture; not executable.\n");
  // The game's own master: Vortex treats it as always enabled, and LOOT loads its header
  // before sorting anything.
  if (!fs.existsSync(path.join(sandbox.dataPath, "Fallout4.esm"))) {
    writePlugin(sandbox.dataPath, { name: "Fallout4.esm", author: "Bethesda (fixture)" });
  }
  // Vortex refuses to activate the game's profile without its INI files.
  for (const ini of INI_FILES) {
    const file = path.join(sandbox.myGames, ini);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[General]\r\n");
  }
  return sandbox;
}

/**
 * Any config, with Vortex's per-user folders moved into the cache: for games other than
 * the fake Fallout 4 that write under Documents or LocalAppData.
 */
export function isolateUserFolders(config: HarnessConfig): HarnessConfig {
  const root = path.join(config.cacheDir, "user-folders", config.gameId);
  const localAppData = path.join(root, "Local");
  const documents = path.join(root, "Documents");
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(documents, { recursive: true });
  return { ...config, profileRedirect: { localAppData, documents } };
}

/** Harness config for the fake Fallout 4, with Vortex's per-user folders redirected. */
export function bethesdaSandboxConfig(config: HarnessConfig): HarnessConfig {
  const sandbox = ensureBethesdaSandbox(config.cacheDir);
  return {
    ...config,
    gameId: sandbox.gameId,
    gamePath: sandbox.gamePath,
    profileRedirect: { localAppData: sandbox.localAppData, documents: sandbox.documents },
  };
}

/**
 * Whether Vortex resolved its per-user folders to the sandbox's. Anything else means
 * managing the game would write to the operator's real profile, and must not happen.
 */
export function assertRedirected(
  expected: NonNullable<HarnessConfig["profileRedirect"]>,
  actual: { documents: string | null; localAppData: string | null } | undefined,
): void {
  const same = (a: string | null | undefined, b: string): boolean =>
    a !== null &&
    a !== undefined &&
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (
    !same(actual?.documents, expected.documents) ||
    !same(actual?.localAppData, expected.localAppData)
  ) {
    throw new Error(
      `Vortex resolved documents=${String(actual?.documents)} and localAppData=` +
        `${String(actual?.localAppData)}, not the sandbox's ${expected.documents} and ` +
        `${expected.localAppData}. Refusing to manage the fake game, which would write to the ` +
        `real Fallout 4 profile. Restart the instance through \`vortex-ai up --bethesda-sandbox\`.`,
    );
  }
}
