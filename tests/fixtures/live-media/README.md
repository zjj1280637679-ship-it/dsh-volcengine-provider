# Controlled live media fixtures

These tiny synthetic assets are committed test inputs, created for this project; they contain no user content. The probe checks the manifest SHA-256 before sending and verifies that decoding the production request yields identical bytes. Fixture creation is separate from the provider: the provider does not resize, transcode or normalize them.

| File | Content | Encoding |
| --- | --- | --- |
| image.png | Red circle on the left, blue square on the right; one transparent corner pixel | 512 × 256 RGBA PNG |
| audio.mp3 | “The code number is seven three one. The fruit is banana.” | Flite `slt` synthetic voice, 44.1 kHz stereo MP3, 64 kbps |
| video.mp4 | Yellow, green, purple screens, two seconds each | 256 × 256, 4 fps, H.264 MP4, six seconds, no audio |

The prompts ask for descriptions/transcription without including these expected answers. The checks establish a small semantic smoke test, not comprehensive model quality or every codec/size boundary. Byte identity establishes client passthrough; it does not claim the supplier avoids internal preprocessing.

Generated using Pillow and FFmpeg 6.1.1 (`flite`, `libmp3lame`, `libx264`). The fixtures need no generation dependency in CI. `manifest.json` records the exact committed bytes.
