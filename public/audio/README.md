# Action sound sources

Both action recordings are distributed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Sources and license statements were checked on 2026-09-28. Audio is bundled locally; playing does not contact these providers.

## chips.wav

- Recording: **Poker Chips**, BigSoundBank #0942, Clarisse, studio recording.
- Source and license: https://bigsoundbank.com/poker-chips-s0942.html
- Site license: https://bigsoundbank.com/licenses.html
- Download used: https://bigsoundbank.com/UPLOAD/mp3/0942.mp3
- Preparation: decode MP3 to signed 16-bit PCM, average stereo channels, keep 0–0.300 seconds, fade the final 12 ms, normalize peak to 0.65, save mono 32 kHz WAV.

## check.wav

- Recording: **Knock_on_door.wav**, Philip_Daniels, Freesound #244325. The author describes three knocks on a wooden desk, recorded using a Realtek headset and edited in Audacity.
- Source and CC0 license: https://freesound.org/people/Philip_Daniels/sounds/244325/
- Download used: https://cdn.freesound.org/previews/244/244325_3151690-hq.mp3
- Preparation: decode MP3 to signed 16-bit PCM; keep 0.255–0.405 and 0.575–0.745 seconds (first two knocks), fade each final 12 ms, place 65 ms of silence between clips, normalize peak to 0.65, save mono 44.1 kHz WAV. Total duration approximately 385 ms.

## Turn reminder

The 420 ms two-note reminder is synthesized by `src/presentation.ts`: 660 Hz then 880 Hz, with a soft attack and exponential decay. It does not use a third-party recording.
