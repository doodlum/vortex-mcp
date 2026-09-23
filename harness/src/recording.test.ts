import { describe, expect, it } from "vitest";
import { videoFrames } from "./recording";

describe("videoFrames", () => {
  it("preserves pauses and frame changes at their recorded time", () => {
    const frames = [
      { elapsed: 0, data: Buffer.from("closed") },
      { elapsed: 200, data: Buffer.from("fading in") },
      { elapsed: 400, data: Buffer.from("open") },
    ];
    expect([...videoFrames(frames, 1000, 5)].map((frame) => frame.toString())).toEqual([
      "closed",
      "fading in",
      "open",
      "open",
      "open",
    ]);
  });
});
