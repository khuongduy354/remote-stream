# Remote Stream

Linux desktop streaming with a native GTK session manager and browser viewers. Create independent virtual desktops, share view-only or control invitations, and hand control between connected viewers.

## Use the installed app

Open **Remote Stream** from the application launcher or your existing i3 entry.

1. Select **Main desktop** to share your existing X11 desktop, or **New desktop** to create an independent i3 desktop.
2. Choose **Open desktop** to work in that session through your browser.
3. Choose a network address and **View only** or **Can control**, then **Copy invite** for the other person.
4. Select a connected viewer and **Give control** to transfer keyboard/mouse control. Viewers with a control invitation can request control or release it in the browser.
5. **End desktop** closes a virtual desktop and its apps. Disconnecting a viewer or closing the panel leaves desktops running.

Each desktop has its own input process and controller. Different desktops accept input simultaneously. Within one desktop, multiple viewers can watch, but only one controls it. The first control-capable viewer gets control when no one holds it. Giving control to someone else releases held keys and mouse buttons first.

**Revoke all invites** disconnects that desktop's viewers and replaces its invitation tokens. Stopping/restarting the server closes every virtual desktop and invalidates all links. The main desktop itself is not terminated.

The audio checkbox changes only the selected desktop's stream. Connected viewers reconnect with the new audio setting; other desktops keep running. Audio overrides last until server restart.

The panel exposes management only through a Unix socket inside an owner-only `.state` directory. Opening the bare browser URL does not grant access; use an invitation from the panel. Invitation links are bearer credentials. Use a trusted LAN, encrypted VPN, or your own HTTPS reverse proxy. This project does not configure a public tunnel or TLS.

## Work while someone games

Create a virtual **Work desktop** for yourself and give the other person a control invitation to **Main desktop**. The work desktop's keyboard and mouse do not move the main desktop's pointer.

Important boundaries:

- Virtual desktops use Xvfb and software graphics. They are suitable for terminals and light desktop work, not GPU-heavy games.
- The main desktop retains its normal graphics stack, but this app's FFmpeg/MSE stream is buffered. It is not a low-latency Moonlight replacement. GPU encoding and game performance must be validated separately.
- Keyboard/mouse input is supported. Gamepad forwarding and relative/pointer-lock mouse input are not implemented, so many games will need another streaming/input path.
- Desktops share the host's Linux account, files, CPU, memory, and GPU resources. They are not security sandboxes or separate user accounts. Share control only with people you trust with that account.
- Each virtual desktop gets a separate D-Bus session, Xauthority cookie, and PulseAudio sink when available. Audio uses that desktop's sink monitor; if sink creation fails, audio is disabled rather than capturing the host. Apps that ignore `PULSE_SINK` may need manual output selection.
- Single-instance apps may still reuse an existing process through profile locks. For example, launch a browser with a separate profile for each desktop.
- Main desktop input is shared with any local user on that display.

There are at most four desktops (including Main desktop) and four viewers per desktop. Each viewer uses a separate encoder so its resolution and buffer can differ. Extra viewers increase CPU usage.

## Run from source

Requirements: Linux, Node.js 22+, FFmpeg with H.264 support, Python 3 with `python-xlib`. The panel needs PyGObject and GTK 3. Virtual desktops need Xvfb, i3, xauth, and dbus-run-session. Install a terminal such as xfce4-terminal. `pactl` enables virtual audio sinks.

On Fedora, install the missing virtual display component with graphical administrator authentication:

```sh
pkexec dnf install xorg-x11-server-Xvfb
```

Then:

```sh
npm ci
npm run doctor
npm start
# In another terminal:
python3 scripts/panel.py
```

Default server binding is `127.0.0.1:8787`. For remote access, set `BIND=0.0.0.0` and `PUBLIC_ORIGIN` to the exact URL viewers use. Add other permitted URLs with `EXTRA_ORIGINS`. The installed user service reads `.state/service.env`; the panel uses that file's origins for sharing.

A usable existing X11 display adds Main desktop. If it is unavailable, the manager can still create virtual desktops. A minimal i3 configuration opens a terminal in each new desktop. `Super+Return` opens another terminal; `Super+d` opens the launcher if dmenu is installed. Host i3 autostart commands are deliberately not loaded inside virtual desktops.

Installed service commands:

```sh
systemctl --user start remote-stream.service
systemctl --user stop remote-stream.service
journalctl --user -u remote-stream.service -n 30
```

The service should use `KillMode=control-group` so its child desktops cannot survive service termination. Clean shutdown also stops desktop process groups and unloads virtual audio sinks. Desktops and invites are not restored after restart; save work before stopping the server.

## Stream settings

Settings are environment variables, applied when the server starts.

| Setting | Default | Purpose |
|---|---|---|
| `WIDTH`, `HEIGHT` | 1280, 720 | Default encoded frame dimensions |
| `FPS` | 30 | 10–60 frames per second |
| `QUALITY` | 20 | Encoder-specific value, 0–51 |
| `ENCODER` | libx264 if available, otherwise libopenh264 | Explicit h264_vaapi, h264_nvenc, h264_qsv also supported |
| `AUDIO` | 0 | Set to 1 to capture main desktop audio |
| `AUDIO_SOURCE` | @DEFAULT_MONITOR@ | Main desktop audio monitor |
| `FRAGMENT_MS` | 250 | Approximate video fragment duration |
| `FFMPEG` | ffmpeg | FFmpeg executable |
| `BIND`, `PORT` | 127.0.0.1, 8787 | Listener address |
| `PUBLIC_ORIGIN` | http://localhost:8787 | Primary browser origin |
| `EXTRA_ORIGINS` | empty | Other allowed browser origins, comma-separated |
| `STATE_DIR` | .state | Local runtime directory; also supported by the panel and control CLI |
| `SOURCE` | desktop | `test` creates synthetic media for the main session |

Browser resolution changes resize only the encoded stream, not desktop geometry. New desktop dimensions are selected at creation. Playback buffers range from 100 to 5000 ms; the 100 ms setting remains experimental because fragments are normally longer than 100 ms.

Streams use FFmpeg H.264/AAC, fragmented MP4 over WebSockets, and native browser MSE. Quality does not adapt to bandwidth. Queues and acknowledgement deadlines are bounded; slow clients reset independently. Chrome/Chromium is the primary tested viewer. Hardware encoder availability does not establish driver support; run `npm run doctor` after changing encoders.

## Local control CLI

The GTK panel uses the same local API:

```sh
npm run control -- status
npm run control -- create 'Work desktop'
npm run control -- grant SESSION_ID VIEWER_ID
npm run control -- revoke SESSION_ID
npm run control -- rotate SESSION_ID
npm run control -- end SESSION_ID
```

Status includes invitation tokens; do not publish its output. Session creation/deletion, token rotation, and control grants are not HTTP endpoints. Invites authorize only their desktop and role. A server-generated viewer identifier binds each input channel to its video connection, including when multiple viewers share a network address.

## Validation

```sh
npm test                 # Media/parser checks, access control, two real X11 desktops
npm run test:browser     # Isolated host, three browser viewers, handoff, resize and reconnect
npm run test:panel       # GTK creation, selection, invite roles and ending a desktop
```

The real-desktop integration test skips when virtual desktop dependencies are missing. On a configured Linux host it verifies simultaneous pointer positions, isolated key state, observer input rejection, control handoff and release, disconnect behavior, invitation revocation, and desktop lifecycle. Browser tests use Playwright and Chrome (`CHROME` overrides `/usr/bin/google-chrome`). They create temporary desktops and never inject keys into the main desktop.

Legacy manual browser/network tests require `TEST_URL` set to a current invitation URL. `tests/input-live.js` is an explicit live-input test: use a control invitation and the matching `DISPLAY`/`XAUTHORITY`, only when no one is typing there.
