# Capture — getting any screen into CourseMate

CourseMate does not care what is on screen. It takes JPEG frames plus audio
chunks over two HTTP endpoints, so anything that can produce those can feed it.
Pick the row that matches your device.

| Where the course is | Path | Audio | Effort |
| --- | --- | --- | --- |
| Laptop/desktop browser, any LMS, any video | The built-in page (`http://127.0.0.1:8790`) | Tab audio **or** mic | none |
| Whole desktop, any app | `frames-bridge.sh` on the host | none (add mic separately) | none |
| Android phone or tablet | `scrcpy` window → `frames-bridge.sh`, or the MediaProjection app | ADB audio (`--audio-source`) or mic | low |
| iPhone / iPad | ReplayKit broadcast extension → server | App audio captured | one Xcode build |
| iPhone mirrored to a TV (AirPlay) | UxPlay receiver window → `frames-bridge.sh` | UxPlay audio out | low |
| Android cast to a TV (Chromecast) | the phone is still the renderer — capture the phone | — | low |
| Laptop cast to a TV | capture the laptop, not the TV | tab audio | none |
| A physical classroom | phone/action-cam → RTSP or HDMI capture card → `frames-bridge.sh` | RTSP/line-in | medium |

## The one honest limitation

Casting to a TV never removes the need to capture *something*: when you AirPlay
or Chromecast from a phone, the phone is still rendering the course. So the
"capture any screen via casting" case is really "capture the phone", which is
the iOS/Android rows above. If you want to capture the *TV's* HDMI output
directly, that needs a hardware capture card — there is no software route.

## 1. Desktop browser (best path)

```bash
cd coursemate && npm start          # http://127.0.0.1:8790
```

Open that URL, name the course, press **Share screen**, and pick the tab (not
the whole screen, if you can help it). Tick **Also share tab audio** so the
lecture is transcribed instead of just being read.

`getDisplayMedia` with system audio works in Chrome and Edge on macOS, Windows
and Linux, and in Firefox on Windows. Safari shares video but not tab audio —
use the mic instead.

## 2. Any window or desktop via ffmpeg

`frames-bridge.sh` samples a video source at a fixed rate and POSTs JPEG
frames. It needs `ffmpeg`, `curl` and `base64`.

```bash
# Whole display on Linux/X11
./frames-bridge.sh --course "BIOL 201" \
  --input "-f x11grab -framerate 2 -i :0.0 -video_size 1920x1080"

# One window (X11), by id
WIN=$(xdotool search --name "Introduction to Biology" | head -1)
./frames-bridge.sh --course "BIOL 201" --input "-f x11grab -framerate 2 -i :0.0+$WIN"

# macOS
./frames-bridge.sh --course "BIOL 201" \
  --input "-f avfoundation -framerate 2 -i '1:none'"

# Windows (ffmpeg gdigrab)
./frames-bridge.sh --course "BIOL 201" --input "-f gdigrab -framerate 2 -i desktop"
```

## 3. Android

Two ways, both fine.

**scrcpy (no app to build).** Mirror the phone to the host and capture the
mirrored window:

```bash
scrcpy --max-size 1280 --no-control &          # shows the phone on your desktop
./frames-bridge.sh --course "CS 101" --input "-f x11grab -framerate 2 -i :0.0+$SCRCPY_WIN"
```

With `scrcpy --audio-source=playback` (2.0+) you also get device audio on the
host; point any recorder at the default sink and post the chunks, or just leave
the mic on.

**MediaProjection helper.** `android/ScreenCaptureService.kt` is a ~130 line
service that captures the screen and POSTs frames directly from the phone — no
host, no ADB. Drop it in an empty Android Studio project with one "Start
capture" button.

> Android Chrome does **not** implement `getDisplayMedia`, so the built-in web
> page will not capture on a phone. That is why this row exists.

## 4. iPhone / iPad

iOS has no browser screen-capture API, and no background recording without a
broadcast extension. That is now a real Xcode project instead of a loose file:
**[github.com/innotelinc/coursemate-ios](https://github.com/innotelinc/coursemate-ios)**
— app plus ReplayKit broadcast extension, App Group configuration, and WAV audio.

```bash
open CourseMate.xcodeproj     # set your team, run on device
```

Start a session in the app, then **Start broadcast**, or long-press the record
control in Control Centre. Signing, App Group and troubleshooting notes live in
that repo's README. Start this server with `COURSEMATE_HOST=0.0.0.0` so the phone
can actually reach it.

## 5. TV casting

- **AirPlay from iPhone/iPad to a TV:** run [UxPlay](https://github.com/FDH2/UxPlay)
  on the machine running CourseMate, then capture its window with
  `frames-bridge.sh`. UxPlay also gives you the audio on the host.
- **Chromecast from Android:** the phone still decodes and renders, so capture
  the phone (row 3). Nothing extra is needed.
- **Casting a laptop to a TV:** capture the laptop (row 1) — the TV is a mirror.
- **Capturing the TV itself:** hardware HDMI capture card, exposed as a V4L2 or
  AVFoundation device, then `frames-bridge.sh --input "-f v4l2 -i /dev/video2"`.

## Protocol

If you want to write your own capture source, two endpoints are all it takes:

```http
POST /api/session          {"course": "BIOL 201"}      -> {"session_id": "ses_..."}

POST /api/ingest/frame     {"session_id": "...", "image_b64": "<jpeg>",
                            "mime": "image/jpeg", "hash": "optional perceptual hash"}

POST /api/ingest/audio     {"session_id": "...", "audio_b64": "<webm|wav|mp4>",
                            "mime": "audio/webm"}
```

Send a frame only when the screen changed — every frame costs one vision call.
`frames-bridge.sh` and the web page both do that diffing for you.
