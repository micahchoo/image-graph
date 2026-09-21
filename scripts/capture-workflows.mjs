#!/usr/bin/env node

/**
 * Turn a directory of real Obsidian screenshots into a reviewable GIF and
 * contact sheet. This script intentionally does not drive Obsidian: capture
 * input and screenshots must come from the approved development vault.
 *
 * Usage:
 *   node scripts/capture-workflows.mjs \
 *     --workflow pan-grid \
 *     --frames /tmp/image-graph-capture/pan-grid \
 *     --output docs/workflows/pan-grid.gif
 */

import { existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith("--")) continue;
  const key = value.slice(2);
  const next = process.argv[index + 1];
  args.set(key, next && !next.startsWith("--") ? next : true);
  if (next && !next.startsWith("--")) index += 1;
}

const workflow = String(args.get("workflow") ?? "workflow");
const frames = resolve(String(args.get("frames") ?? ""));
const output = resolve(String(args.get("output") ?? `docs/workflows/${workflow}.gif`));
const fps = Number(args.get("fps") ?? 6);
const width = Number(args.get("width") ?? 1280);
// --crop W:H:X:Y trims window chrome the clip does not need, before scaling.
const crop = args.has("crop") ? String(args.get("crop")) : "";

if (!args.has("frames") || !existsSync(frames) || !statSync(frames).isDirectory()) {
  throw new Error("--frames must point to an existing screenshot directory");
}
if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(width) || width < 320) {
  throw new Error("--fps must be positive and --width must be at least 320");
}
if (crop && !/^\d+:\d+:\d+:\d+$/.test(crop)) {
  throw new Error("--crop must be W:H:X:Y in pixels");
}

const pngs = readdirSync(frames)
  .filter((file) => /\.png$/i.test(file))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  .map((file) => join(frames, file));
if (pngs.length < 2) throw new Error("at least two PNG frames are required");

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};

mkdirSync(dirname(output), { recursive: true });
const stem = output.replace(/\.gif$/i, "");
const contactSheet = `${stem}.contact-sheet.png`;
const pattern = join(frames, "frame-%04d.png");

// Scale only down; keep the UI legible and preserve the capture aspect ratio.
run("ffmpeg", [
  "-y", "-framerate", String(fps), "-i", pattern,
  "-vf", `${crop ? `crop=${crop},` : ""}scale='min(iw,${width})':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`,
  "-loop", "0", "-an", output,
]);

// The contact sheet is the review artifact: it exposes stale controls,
// failed intermediate states, and accidental unrelated windows frame by frame.
run("magick", [
  "montage",
  ...pngs,
  ...(crop ? ["-crop", crop.replace(/^(\d+):(\d+):(\d+):(\d+)$/, "$1x$2+$3+$4"), "+repage"] : []),
  "-thumbnail", `${Math.round(width / 4)}x`,
  "-tile", "4x", "-geometry", "+8+8", "-background", "#111c", contactSheet,
]);

console.log(JSON.stringify({ workflow, frames: pngs.length, gif: output, contactSheet }, null, 2));
