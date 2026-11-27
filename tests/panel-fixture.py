"""Exercise the real GTK widgets against an isolated running host."""
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
from panel import Panel, Gtk, Gdk, GLib

panel = Panel()
panel.show_all()

def wait(check, message, timeout=15):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        if check(): return
        time.sleep(.03)
    raise AssertionError(message)

def answer_create():
    for window in Gtk.Window.list_toplevels():
        if isinstance(window, Gtk.Dialog) and window.get_title() == 'New independent desktop':
            for widget in window.get_content_area().get_children():
                if isinstance(widget, Gtk.Entry): widget.set_text('Created from GTK')
            window.response(Gtk.ResponseType.OK)
            return False
    return True

def answer_confirm():
    for window in Gtk.Window.list_toplevels():
        if isinstance(window, Gtk.MessageDialog):
            window.response(Gtk.ResponseType.OK)
            return False
    return True

try:
    wait(lambda: panel.running and panel.new_button.get_sensitive(), 'Panel did not load server state')
    GLib.timeout_add(100, answer_create)
    panel.new_button.clicked()
    wait(lambda: not panel.busy and any(s['name'] == 'Created from GTK' for s in panel.sessions.values()), 'GUI did not create desktop')
    item = panel.sessions[panel.session.get_active_id()]
    assert item['name'] == 'Created from GTK'
    assert panel.end_button.get_sensitive()
    if panel.audio.get_sensitive():
        panel.audio.set_active(False)
        wait(lambda: not panel.busy and not panel.sessions[item['id']]['audio'], 'GUI did not toggle session audio')
    panel.role.set_active_id('view')
    assert panel.link.get_text().endswith(item['tokens']['view'])
    panel.copy_button.clicked()
    assert Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text() == panel.link.get_text()
    panel.role.set_active_id('control')
    assert panel.link.get_text().endswith(item['tokens']['control'])
    # Mask the credential in the saved UI artifact.
    panel.link.set_visibility(False)
    ready_at = time.monotonic() + .3
    wait(lambda: time.monotonic() > ready_at, 'Panel not rendered')
    screenshot = Gdk.pixbuf_get_from_window(panel.get_window(), 0, 0, panel.get_allocated_width(), panel.get_allocated_height())
    screenshot.savev('/tmp/remote-stream-panel.png', 'png', [], [])
    old_token = item['tokens']['control']
    GLib.timeout_add(100, answer_confirm)
    panel.rotate_button.clicked()
    wait(lambda: not panel.busy and panel.sessions[item['id']]['tokens']['control'] != old_token, 'GUI did not revoke invites')
    panel.session.set_active_id('host')
    assert not panel.end_button.get_sensitive()
    panel.session.set_active_id(item['id'])
    GLib.timeout_add(100, answer_confirm)
    panel.end_button.clicked()
    wait(lambda: not panel.busy and item['id'] not in panel.sessions, 'GUI did not end desktop')
    print('PASS: GTK create dialog, selection, invite roles, clipboard, revoke invites, end confirmation and main-desktop guard.', flush=True)
finally:
    # No Gtk.main() loop was entered by this test, so avoid the application's quit callback.
    panel.hide()
