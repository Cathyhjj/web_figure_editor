# Synthetic MP4 fixture

`video.mp4` is six seconds of FFmpeg's generated testsrc2 pattern and a quiet generated sine tone. It contains no user data or third-party footage. Codec: H.264 Constrained Baseline, yuv420p, 320 × 180 at 15 fps; AAC audio. `video-poster.png` is its first frame.

Regenerate from the repository root (remove only these generated fixtures first, or use `-y`):

```sh
ffmpeg -f lavfi -i 'testsrc2=size=320x180:rate=15:duration=6' -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=6' -filter:a 'volume=0.03' -c:v libx264 -profile:v baseline -pix_fmt yuv420p -crf 30 -c:a aac -b:a 32k -movflags +faststart -shortest tests/fixtures/video.mp4
ffmpeg -i tests/fixtures/video.mp4 -frames:v 1 tests/fixtures/video-poster.png
```
