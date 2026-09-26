/**
 * The things that need a real browser, over CDP.
 *
 * Two capabilities live here, and both are genuinely out of reach of an
 * extension running in the renderer:
 *
 * This is the one capability the extension genuinely cannot provide.
 * `webContents.capturePage` lives in the main process, and Vortex extensions are
 * renderer-only (`onceMain` is deprecated and logs that it will not work as
 * expected). The obvious fix — adding a `window:capturePage` IPC to Vortex — was
 * built and then deliberately discarded, because it meant the whole system only
 * worked against a patched Vortex.
 *
 * Attaching over CDP costs nothing and works against the released build:
 * Electron parses `--remote-debugging-port` from argv itself, so the harness
 * just launches Vortex with it (see instance.ts) and Playwright connects. Same
 * pictures, no patch.
 *
 * The second is **real hover**. `ui_hover` dispatches pointerover/mouseover
 * events, which run React handlers but do NOT change the browser's own hover
 * state — so a control revealed purely by CSS `:hover` stays invisible. Vortex's
 * game tiles are exactly that: the "Manage" button sits in a `.hover-content`
 * wrapper at `opacity: 0`. Only a real mouse move updates `:hover`, and CDP is
 * the only way to produce one.
 */
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";

import type { HarnessConfig } from "./config";

export class CdpUnavailableError extends Error {}

export interface RendererHandle {
  page: Page;
  close: () => Promise<void>;
}

/**
 * Attach to the running Vortex's renderer window.
 *
 * Vortex opens a splash window as well as the main one, so the target is picked
 * by URL and window name rather than by taking whichever page appears first.
 * A same-origin panel pop-out can inherit the main renderer's index.html URL.
 */
export async function attachToRenderer(config: HarnessConfig): Promise<RendererHandle> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(config.cdpPort)}`);
  } catch (err) {
    throw new CdpUnavailableError(
      `Could not attach to Vortex over CDP on port ${String(config.cdpPort)}. ` +
        `The harness launches Vortex with --remote-debugging-port, so this usually means the ` +
        `instance was started some other way. Restart it with \`vortex-ai up\`.`,
      { cause: err },
    );
  }

  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = await selectRendererPage(pages);
  if (page === undefined) {
    await browser.close().catch(() => undefined);
    throw new CdpUnavailableError("Vortex exposes CDP but has no open window to attach to.");
  }

  // Functions a script passes to page.evaluate carry tsx's `__name(...)` calls (below).
  await page.evaluate(NAME_SHIM).catch(() => undefined);
  await page.addInitScript(NAME_SHIM).catch(() => undefined);
  return { page, close: () => browser.close().catch(() => undefined) };
}

/**
 * Page source defining esbuild's `__name` helper in the renderer, if nothing has.
 *
 * tsx compiles every file with esbuild's `keepNames`, hard-coded, which wraps each named inner
 * function in `__name(fn, "name")`. A function a script passes to `page.evaluate` is sent as its
 * source text, so in the page that helper is a free variable and the call throws
 * "ReferenceError: __name is not defined". `attachToRenderer` runs this on attach and on every
 * later navigation of that connection, so `page.evaluate(() => { const f = () => …; })` works
 * from `vortex-ai script` and the `ai:test:*` checks. It only sets a function's `name`, which is
 * what esbuild's own helper does.
 */
export const NAME_SHIM = `(() => {
  if (typeof globalThis.__name !== "function") {
    Object.defineProperty(globalThis, "__name", {
      configurable: true,
      writable: true,
      value: (target, value) => {
        try {
          Object.defineProperty(target, "name", { value, configurable: true });
        } catch {
          // a frozen or non-configurable name: leave it
        }
        return target;
      },
    });
  }
  return true;
})()`;

export async function selectRendererPage(pages: Page[]): Promise<Page | undefined> {
  const candidates = [
    ...pages.filter((page) => page.url().includes("index.html")),
    ...pages.filter((page) => !page.url().includes("index.html")),
  ];
  for (const page of candidates) {
    const name = await page.evaluate(() => window.name).catch(() => undefined);
    if (name !== undefined && !name.startsWith("vortex-panel-")) return page;
  }
  return undefined;
}

export interface ScreenshotOptions {
  /** Written under the artifact directory. Defaults to a timestamped name. */
  label?: string;
  /** Capture the full scrollable page rather than just the viewport. */
  fullPage?: boolean;
  /** Reuse an already-attached renderer instead of connecting per shot. */
  handle?: RendererHandle;
}

/** Capture the Vortex window to a PNG under the artifact directory. */
export async function captureScreenshot(
  config: HarnessConfig,
  options: ScreenshotOptions = {},
): Promise<string> {
  const handle = options.handle ?? (await attachToRenderer(config));
  try {
    fs.mkdirSync(config.artifactDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const label = (options.label ?? "screenshot").replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = path.join(config.artifactDir, `${label}-${stamp}.png`);

    if (options.fullPage === true) {
      await handle.page.screenshot({ path: file, fullPage: true });
    } else {
      // Playwright's viewport clip can crop Electron windows at non-default zoom.
      // Let Chromium capture its surface without deriving a clip from CSS pixels.
      const session = await handle.page.context().newCDPSession(handle.page);
      try {
        const result = await session.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        fs.writeFileSync(file, Buffer.from(result.data, "base64"));
      } finally {
        await session.detach();
      }
    }
    return file;
  } finally {
    // Only close what we opened; a caller-supplied handle stays alive so a
    // sweep does not pay a fresh CDP connection per viewport.
    if (options.handle === undefined) await handle.close();
  }
}

/**
 * Hover an element the way a mouse does, updating CSS `:hover`.
 *
 * Use this — not `ui_hover` — whenever the thing you need to see is revealed by
 * a CSS hover rule rather than a JS handler. The distinction is invisible until
 * it bites: the element is in the DOM either way, so the failure looks like "the
 * button exists but the snapshot says it is hidden".
 */
export async function realHover(
  config: HarnessConfig,
  selector: string,
  options: { handle?: RendererHandle; timeoutMs?: number } = {},
): Promise<void> {
  const handle = options.handle ?? (await attachToRenderer(config));
  try {
    await handle.page.hover(selector, { timeout: options.timeoutMs ?? 15_000 });
  } finally {
    if (options.handle === undefined) await handle.close();
  }
}

/** Send a native wheel gesture, including modifiers; DOM scroll does not exercise zoom shortcuts. */
export async function realWheel(
  config: HarnessConfig,
  selector: string,
  deltaY: number,
  options: { handle?: RendererHandle; control?: boolean } = {},
): Promise<void> {
  const handle = options.handle ?? (await attachToRenderer(config));
  try {
    await handle.page.hover(selector);
    if (options.control) await handle.page.keyboard.down("Control");
    try {
      await handle.page.mouse.wheel(0, deltaY);
    } finally {
      if (options.control) await handle.page.keyboard.up("Control");
    }
  } finally {
    if (options.handle === undefined) await handle.close();
  }
}
