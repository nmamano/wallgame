import { execFileSync } from "node:child_process";

const run = (bin, args, encoding = null) =>
  execFileSync(bin, args, {
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const vectors = (bytes, vectorSize) => {
  if (bytes.length % vectorSize !== 0) {
    throw new Error(
      `decoded byte count ${bytes.length} is not divisible by ${vectorSize}`,
    );
  }
  return Array.from({ length: bytes.length / vectorSize }, (_, i) =>
    bytes.subarray(i * vectorSize, (i + 1) * vectorSize),
  );
};

const distance = (a, b) => {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
};

export function verifyEncodedVideo({
  ffmpeg,
  video,
  framePattern,
  fps,
  ranges,
  crop,
}) {
  const probe = JSON.parse(
    run(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time,duration_time,pkt_duration_time",
        "-of",
        "json",
        video,
      ],
      "utf8",
    ),
  );
  const frames = probe.frames ?? [];
  const expectedFrames = ranges.at(-1)?.endFrame ?? 0;
  if (frames.length !== expectedFrames) {
    throw new Error(
      `encoded ${frames.length} frames; timeline requires ${expectedFrames}`,
    );
  }
  const step = 1 / fps;
  for (let i = 0; i < frames.length; i += 1) {
    const pts = Number(frames[i].best_effort_timestamp_time);
    const rawDuration = frames[i].duration_time ?? frames[i].pkt_duration_time;
    if (rawDuration == null) {
      throw new Error(
        `ffprobe did not report an encoded duration for frame ${i}`,
      );
    }
    const duration = Number(rawDuration);
    if (
      Math.abs(pts - i * step) > 0.00001 ||
      Math.abs(duration - step) > 0.00001
    ) {
      throw new Error(
        `frame ${i} has pts ${pts}, duration ${duration}; expected ${i * step}, ${step}`,
      );
    }
  }

  const sample = 64;
  const filter = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${sample}:${sample},format=gray`;
  const referenceBytes = run(ffmpeg, [
    "-v",
    "error",
    "-framerate",
    String(fps),
    "-i",
    framePattern,
    "-vf",
    filter,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
  ]);
  const actualBytes = run(ffmpeg, [
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    filter,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
  ]);
  const reference = vectors(referenceBytes, sample * sample);
  const actual = vectors(actualBytes, sample * sample);
  if (reference.length !== expectedFrames || actual.length !== expectedFrames) {
    throw new Error(
      `decoded reference ${reference.length} and output ${actual.length}; expected ${expectedFrames}`,
    );
  }

  const moveRanges = ranges.filter(
    (range) => range.kind === "move" || range.kind === "initial",
  );
  const representatives = moveRanges.map((range) => ({
    ply: range.ply,
    pixels: reference[Math.floor((range.startFrame + range.endFrame - 1) / 2)],
  }));
  const classified = [];
  let worstExpectedDistance = 0;
  for (const range of ranges) {
    if (range.endFrame <= range.startFrame)
      throw new Error(`zero-duration range ${range.kind}`);
    if (range.kind !== "move" && range.kind !== "initial") continue;
    const counts = new Map();
    for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
      const ranked = representatives
        .map((candidate) => ({
          ply: candidate.ply,
          d: distance(actual[frame], candidate.pixels),
        }))
        .sort((a, b) => a.d - b.d);
      counts.set(ranked[0].ply, (counts.get(ranked[0].ply) ?? 0) + 1);
      const expectedDistance = distance(actual[frame], reference[frame]);
      worstExpectedDistance = Math.max(worstExpectedDistance, expectedDistance);
      if (ranked[0].ply !== range.ply) {
        throw new Error(
          `decoded frame ${frame} classified as ply ${ranked[0].ply}, expected ${range.ply}`,
        );
      }
    }
    classified.push({
      ply: range.ply,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      startTime: range.startFrame / fps,
      endTime: range.endFrame / fps,
      decodedFrames: range.endFrame - range.startFrame,
      classifications: Object.fromEntries(counts),
    });
  }
  return {
    fps,
    frameCount: frames.length,
    duration: frames.length / fps,
    ptsStep: step,
    worstExpectedPixelMae: worstExpectedDistance,
    classified,
    transitions: ranges
      .filter((range) => range.kind !== "move" && range.kind !== "initial")
      .map(({ kind, startFrame, endFrame }) => ({
        kind,
        startFrame,
        endFrame,
      })),
  };
}
