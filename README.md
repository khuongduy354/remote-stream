# Quality-first Remote Stream

A working Linux/X11 host and Chrome browser viewer. FFmpeg captures and encodes the desktop; native browser MSE plays H.264/AAC over WebSockets without sign-in. No cloud service, custom decoder, or subscription.

## Open the installed application

Search **Remote Stream** in the Linux application launcher. The GTK host panel starts/stops the server, opens the viewer, copies LAN/Tailscale links and toggles system audio. Closing the panel leaves the server running.

- This computer: http://localhost:8787
- Current LAN address: http://192.168.31.92:8787
- Existing VPN address: http://100.74.110.72:8787 (requires access to that VPN)

Open a viewer link to connect automatically. No token, password, or approval is required. Mouse and keyboard control are enabled automatically. Only one viewer is permitted at a time. **Anyone who can reach port 8787 can view and control the PC while the server runs.** Stop sharing in the host panel to end access. Tailscale access still depends on your network permissions.

The server and host panel start automatically at i3 login. The panel opens on workspace 9; closing it leaves the server running. Startup is configured in `~/.config/i3/config` through `remote-stream-panel.service`. No firewall rules were changed. Another device must be able to reach port 8787 on the LAN/VPN. Addresses may change; edit `.state/service.env` and restart the service if necessary. Use HTTP only on a trusted LAN or encrypted VPN; use HTTPS/WSS behind your own reverse proxy for public access. This project does not provision TLS or a public tunnel.

## Run from source

Requirements: Node.js 22+, FFmpeg with H.264 support; Linux/X11 desktop capture; Python 3 with `python-xlib` for input. The optional desktop panel uses PyGObject and GTK 3. No administrator privileges are needed at runtime.

```sh
npm ci
npm run doctor
npm start
```

Without environment overrides, `npm start` binds only to `127.0.0.1:8787`. Open http://localhost:8787. Stop the installed user service first if it already occupies the port:

```sh
systemctl --user stop remote-stream.service
```

For system audio, use `AUDIO=1 npm start`. For synthetic video and tone, use `SOURCE=test AUDIO=1 npm start`. Optional emergency input overrides remain available from the terminal; new video connections enable control again:

```sh
npm run control -- allow
npm run control -- revoke
npm run control -- status
```

Installed service commands:

```sh
systemctl --user start remote-stream.service
systemctl --user stop remote-stream.service
journalctl --user -u remote-stream.service -n 30
```

## Settings

Host settings are environment variables, applied on restart. The installed service reads `.state/service.env`.

| Setting | Default | Notes |
|---|---|---|
| `WIDTH`, `HEIGHT` | 1280, 720 | Even dimensions; aspect-preserving scaling with padding |
| `FPS` | 30 | 10–60 |
| `QUALITY` | 20 | Encoder-specific quality value, 0–51; not comparable across encoders |
| `ENCODER` | libx264 if installed, otherwise libopenh264 | Also supports explicit h264_vaapi, h264_nvenc, h264_qsv |
| `AUDIO` | 0 | 1 enables AAC system audio; installed service currently enables it |
| `AUDIO_SOURCE` | @DEFAULT_MONITOR@ | PulseAudio/PipeWire monitor source |
| `FRAGMENT_MS` | 250 | Approximate GOP duration, rounded to whole frames |
| `FFMPEG` | ffmpeg | Path to an alternative build |
| `BIND`, `PORT` | 127.0.0.1, 8787 | Non-loopback bind requires PUBLIC_ORIGIN |
| `PUBLIC_ORIGIN` | http://localhost:8787 | Exact browser URL origin |
| `EXTRA_ORIGINS` | empty | Comma-separated additional allowed origins |
| `SOURCE` | desktop | test produces synthetic media |

The viewer exposes a resolution selector with aspect-ratio labels, 100–5000 ms buffer presets, audio mute and fullscreen. Resolution presets include 640×480 through 1600×1200 (4:3), and 1280×720 through 2560×1440 (16:9). Host default uses WIDTH/HEIGHT. Changing resolution reconnects and starts a fresh decoder automatically. This changes the encoded stream, not the host display mode; mismatched aspect ratios receive padding instead of stretching. The chosen resolution lasts for the current page session and survives reconnects. Diagnostics are collapsed by default. Optional playback-rate correction remains disabled internally. A 100 ms setting is experimental: the default fragment itself is approximately 267 ms at 30 FPS. Resolution, encoding settings, and frame rate never adapt to bandwidth.

This Fedora host has working OpenH264 software encoding. Its installed FFmpeg lacks libx264. Intel VAAPI and QSV H.264 probes failed; hardware support is not claimed. OpenH264 uses disabled rate control with fixed quantizer bounds, **not CRF**. x264 uses CRF; hardware selections use their own quality-oriented settings. A listed encoder is not proof that its driver supports encoding: run `npm run doctor` after changing it.

## Validation and architecture corrections

The proposed architecture is feasible. [go2rtc's WebSocket protocol](https://github.com/AlexxIT/go2rtc/blob/master/internal/api/ws/README.md) already supports MSE/fMP4. [Selkies](https://github.com/selkies-project/selkies) supplies a larger remote desktop stack. Neither was adopted wholesale: this small prototype needs explicit delayed playback, a single local host, and simple default-on input. It reuses FFmpeg, native MSE/video, `ws`, and Python Xlib. [Enigo](https://github.com/enigo-rs/enigo) remains a candidate if additional host platforms are added; an extra Rust build was unnecessary for this X11 host.

Corrections to the original assumptions:

- TCP preserves bytes but stalls subsequent bytes while recovering losses. Buffers mask only bounded outages; sustained bandwidth deficits force a visible reset.
- Fixed CRF/QP is not constant perceptual quality or constant bitrate. There is no adaptive quality reduction here.
- Maximum latency requires discarding stale media eventually. This implementation restarts FFmpeg and MSE with a new initialization segment, rather than seeking to an arbitrary delta frame. Reset causes a visible buffering interval.
- Immediate input is possible, but the user acts on delayed imagery. Separate sockets avoid the video's application queue, not shared network congestion.
- Exact end-to-end latency needs capture timestamps mapped to displayed frames and clock calibration. The overlay reports a clock-adjusted **timeline-delay estimate** anchored to FFmpeg launch, not a precision capture-to-photon measurement.
- Received bitrate is measured goodput, not available link capacity. Capacity is explicitly marked unmeasured.
- Browser-reserved shortcuts cannot all be intercepted. Keyboard mapping currently covers common US-layout keys and modifiers. Touch provides pointer movement and dragging; advanced gestures and mobile virtual keyboard entry are not implemented.

Chrome/Chromium is the first target per the updated scope. Runtime codec checks reject unsupported browsers. [MSE capability checks](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/isTypeSupported_static) indicate probable support, not successful decoding. [WebKit documents ManagedMediaSource on iPadOS](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/), but Safari, iPadOS, Windows, and macOS clients have **not** been device-tested. The optional ManagedMediaSource fallback is unverified; native HLS fallback is not implemented. Wayland, macOS and Windows **hosts** are not implemented.

## Bounds and security

- There is no authentication, login cookie, token file, or session expiry. Browser WebSockets still require an allowed origin to prevent unrelated websites from opening them. Non-browser clients can connect without an Origin header. Input and video must come from the same peer address; this is association, not authentication.
- The status/emergency control endpoint is a local Unix socket in an owner-only directory, never a browser route. Disconnect, revoke, missing heartbeat, blur, and hidden pages release input. The Python input helper independently releases held input after 3 seconds without events.
- Server video queue limit: 8 MiB. MP4 box/fragment and browser pending-byte limit: 16 MiB. Browser pending-message limit: 100.
- The server resets clients that fail to acknowledge received fragments within `max(3000, 2 × targetBuffer + 1000)` ms. Acknowledgements indicate receipt, not decoding; the browser separately checks playback progress and media lag.
- Played content is pruned, retaining approximately 2–4 seconds behind the playhead. Client lag thresholds trigger a fresh stream. FFmpeg capture queues are bounded at 64 packets per input.
- Reconnect uses capped exponential backoff. Hidden tabs disconnect to prevent accumulating stale video.
- Source resolution changes require restarting the host. Audio/video share FFmpeg timestamps and browser playback clock; long-duration A/V drift is not yet validated.

## Tests

```sh
npm test                           # Parser, buffer math, open access, AAC mux, congestion reset
npm run test:browser                # Live desktop, rendered dimensions, buffer change, reconnect
node tests/network-browser.js      # Browser message-delivery interruptions
node tests/input-live.js           # Opt-in: briefly presses Right Shift on the host
```

Browser tests need an already-running server with no viewer connected, Playwright, and Chrome at `/usr/bin/google-chrome` (or set `CHROME`). Set `TEST_URL` for another local instance. The live input test should run when no one is using the host keyboard.

Observed on this Linux host in Chrome: 1280×720, 30 rendered FPS, approximately 1 second buffered, zero dropped frames/rebuffers during short steady-state runs. AAC decoding, 2-second buffer selection, decoder reinitialization, key injection, revocation release, and disconnect release passed. A 450 ms delivery interruption stayed smooth; a 4.2-second interruption recovered through a bounded reset. These are short local tests and simulated WebSocket delivery stalls, not a WAN soak test or packet-loss benchmark. Physical touch devices and long-duration synchronization remain untested.
