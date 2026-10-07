#!/usr/bin/env bash
# Prepares the homepage demo: trims to 30s, web-friendly H.264 (~720p), fast start, plus a poster frame.
# Usage: scripts/add-demo-video.sh path/to/your-recording.mov
set -euo pipefail
IN="${1:?Give the path to your recording}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/media"
mkdir -p "$OUT_DIR"
ffmpeg -y -hide_banner -loglevel error -i "$IN" -t 30 \
  -vf "scale='min(1280,iw)':-2,fps=30" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -ac 2 -movflags +faststart "$OUT_DIR/memoria-demo.mp4"
ffmpeg -y -hide_banner -loglevel error -ss 1 -i "$OUT_DIR/memoria-demo.mp4" -frames:v 1 -q:v 3 "$OUT_DIR/memoria-demo.jpg"
du -h "$OUT_DIR/memoria-demo.mp4" "$OUT_DIR/memoria-demo.jpg"
