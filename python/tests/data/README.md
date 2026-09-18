# Test data

## `speech_then_silence.wav`

5.8 s of 16 kHz mono 16-bit PCM: 0.5 s of digital silence, one spoken
sentence, then 2 s of digital silence. `test_speech_devices.py` runs the real
Silero VAD model over it.

- Source: https://archive.org/details/adventuressherlockholmes_v4_1501_librivox,
  file `adventuresofsherlockholmes_01_doyle_64kb.mp3`, from 35.40 s to 38.70 s.
- Book: _The Adventures of Sherlock Holmes_ by Sir Arthur Conan Doyle, "A
  Scandal in Bohemia".
- Reader: David Clarke.
- License: public domain (LibriVox).

The sentence is "I have seldom heard him mention her under any other name."
The voice starts about 0.65 s into the clip and stops about 3.64 s in, where
the level over 20 ms rises above and falls below -45 dBFS. The room tone
around it sits near -63 dBFS.

Made with ffmpeg:

```sh
ffmpeg -i adventuresofsherlockholmes_01_doyle_64kb.mp3 -t 55 -ac 1 -ar 16000 -c:a pcm_s16le full.wav
ffmpeg -i full.wav \
  -af "atrim=start=35.40:end=38.70,asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=3.28:d=0.02,adelay=500:all=1,apad=pad_dur=2" \
  -ac 1 -ar 16000 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact -flags:a +bitexact \
  speech_then_silence.wav
```
