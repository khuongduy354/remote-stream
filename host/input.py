"""Small XTEST adapter. Python Xlib supplies the X11 protocol implementation."""
import json
import os
import select
import sys
from Xlib import X, XK, display
from Xlib.ext import xtest

connection = display.Display()
if not connection.has_extension('XTEST'):
    raise RuntimeError('XTEST unavailable')
held_keys, held_buttons = set(), set()
keys = {
    'Enter': 'Return', 'Escape': 'Escape', 'Backspace': 'BackSpace', 'Tab': 'Tab',
    'Space': 'space', 'ShiftLeft': 'Shift_L', 'ShiftRight': 'Shift_R',
    'ControlLeft': 'Control_L', 'ControlRight': 'Control_R', 'AltLeft': 'Alt_L',
    'AltRight': 'Alt_R', 'MetaLeft': 'Super_L', 'MetaRight': 'Super_R',
    'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
    'Delete': 'Delete', 'Home': 'Home', 'End': 'End', 'PageUp': 'Prior',
    'PageDown': 'Next', 'Insert': 'Insert', 'CapsLock': 'Caps_Lock',
    'Minus': 'minus', 'Equal': 'equal', 'BracketLeft': 'bracketleft',
    'BracketRight': 'bracketright', 'Backslash': 'backslash', 'Semicolon': 'semicolon',
    'Quote': 'apostrophe', 'Backquote': 'grave', 'Comma': 'comma',
    'Period': 'period', 'Slash': 'slash',
}
keys.update({f'Key{c}': c.lower() for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'})
keys.update({f'Digit{i}': str(i) for i in range(10)})
keys.update({f'F{i}': f'F{i}' for i in range(1, 13)})

def release():
    for key in held_keys:
        xtest.fake_input(connection, X.KeyRelease, key)
    for button in held_buttons:
        xtest.fake_input(connection, X.ButtonRelease, button)
    held_keys.clear()
    held_buttons.clear()
    connection.sync()

print(json.dumps({'ready': True}), flush=True)
pending = b''
try:
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], 3)
        if not ready:
            release()
            continue
        chunk = os.read(sys.stdin.fileno(), 4096)
        if not chunk:
            break
        pending += chunk
        if len(pending) > 32768:
            release()
            break
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            try:
                event = json.loads(line)
                kind = event.get('type')
                if kind == 'release':
                    release()
                elif kind == 'move':
                    screen = connection.screen()
                    xtest.fake_input(connection, X.MotionNotify,
                        x=round(max(0, min(1, event['x'])) * (screen.width_in_pixels - 1)),
                        y=round(max(0, min(1, event['y'])) * (screen.height_in_pixels - 1)))
                elif kind == 'button':
                    button = {0: 1, 1: 2, 2: 3}.get(event.get('button'))
                    if button:
                        down = event.get('down') is True
                        if down and button not in held_buttons or not down and button in held_buttons:
                            xtest.fake_input(connection, X.ButtonPress if down else X.ButtonRelease, button)
                            (held_buttons.add if down else held_buttons.discard)(button)
                elif kind == 'key':
                    name = keys.get(event.get('code'))
                    key = connection.keysym_to_keycode(XK.string_to_keysym(name)) if name else 0
                    if key:
                        down = event.get('down') is True
                        if down and key not in held_keys or not down and key in held_keys:
                            xtest.fake_input(connection, X.KeyPress if down else X.KeyRelease, key)
                            (held_keys.add if down else held_keys.discard)(key)
                elif kind == 'wheel':
                    for axis, negative, positive in [('dy', 4, 5), ('dx', 6, 7)]:
                        delta = event.get(axis, 0)
                        button = positive if delta > 0 else negative
                        for _ in range(min(10, round(abs(delta) / 50))):
                            xtest.fake_input(connection, X.ButtonPress, button)
                            xtest.fake_input(connection, X.ButtonRelease, button)
                connection.flush()
            except (ValueError, TypeError, KeyError):
                release()
finally:
    release()
    connection.close()
