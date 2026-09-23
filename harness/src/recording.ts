import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { attachToRenderer, type RendererHandle } from "./cdp";
import type { HarnessConfig } from "./config";

interface Frame {
  elapsed: number;
  data: Buffer;
}

/** Repeat unchanged frames so Chromium's change-only stream retains real timing. */
export function* videoFrames(frames: Frame[], duration: number, fps = 30): Generator<Buffer> {
  let index = 0;
  for (let tick = 0; tick < Math.ceil((duration * fps) / 1000); tick++) {
    while (index + 1 < frames.length && frames[index + 1]!.elapsed <= (tick * 1000) / fps) index++;
    yield frames[index]!.data;
  }
}

/** Record only Vortex's renderer; never captures the desktop or another app. */
export async function startRecording(
  config: HarnessConfig,
  options: { encoder: string; label: string; handle?: RendererHandle },
): Promise<{ stop: () => Promise<string> }> {
  if (!fs.existsSync(options.encoder))
    throw new Error(`Video encoder not found: ${options.encoder}`);
  const handle = options.handle ?? (await attachToRenderer(config));
  const session = await handle.page.context().newCDPSession(handle.page);
  const frames: Frame[] = [];
  const start = performance.now();
  let stopped = false;
  let result: Promise<string> | undefined;
  try {
    const first = await session.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    frames.push({ elapsed: 0, data: Buffer.from(first.data, "base64") });
    session.on("Page.screencastFrame", (event) => {
      if (!stopped)
        frames.push({
          elapsed: performance.now() - start,
          data: Buffer.from(event.data, "base64"),
        });
      void session
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(() => undefined);
    });
    await session.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 });
  } catch (error) {
    await session.detach();
    if (!options.handle) await handle.close();
    throw error;
  }

  const stop = async (): Promise<string> => {
    stopped = true;
    const duration = performance.now() - start;
    try {
      await session.send("Page.stopScreencast");
    } finally {
      await session.detach();
      if (!options.handle) await handle.close();
    }
    fs.mkdirSync(config.artifactDir, { recursive: true });
    const file = path.join(
      config.artifactDir,
      `${options.label.replace(/[^a-zA-Z0-9_-]/g, "_")}.webm`,
    );
    const encoder = spawn(
      options.encoder,
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        "30",
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libvpx",
        "-deadline",
        "realtime",
        "-cpu-used",
        "4",
        "-b:v",
        "2500k",
        file,
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let errors = "";
    encoder.stderr.on("data", (data: Buffer) => {
      errors += data.toString();
    });
    const finished = once(encoder, "close");
    try {
      for (const frame of videoFrames(frames, duration)) {
        if (!encoder.stdin.write(frame)) await once(encoder.stdin, "drain");
      }
      encoder.stdin.end();
      const [code] = await finished;
      if (code !== 0) throw new Error(`Video encoding failed: ${errors}`);
      return file;
    } finally {
      if (encoder.exitCode === null) encoder.kill();
    }
  };
  return { stop: () => (result ??= stop()) };
}
