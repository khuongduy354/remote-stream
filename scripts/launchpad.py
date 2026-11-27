#!/usr/bin/env python3
"""Full-screen application grid for the isolated Xfce preset."""
import base64
import hashlib
import json
import os
from pathlib import Path
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gio, Gtk, WebKit2

ROOT = Path(__file__).resolve().parent.parent


class Launchpad(Gtk.Application):
    def __init__(self):
        display = hashlib.sha256(os.environ.get('DISPLAY', '').encode()).hexdigest()[:12]
        super().__init__(application_id='local.remote_stream.Launchpad.d' + display)
        self.window = None

    def do_activate(self):
        if self.window:
            self.window.present()
            return
        self.apps = {}
        entries = []
        theme = Gtk.IconTheme.get_default()
        for app in sorted(Gio.AppInfo.get_all(), key=lambda a: a.get_display_name().casefold()):
            if not app.should_show() or not app.get_id():
                continue
            app_id = app.get_id()
            self.apps[app_id] = app
            icon = None
            try:
                info = theme.lookup_by_gicon(app.get_icon(), 96, Gtk.IconLookupFlags.FORCE_SIZE)
                if info:
                    _, data = info.load_icon().save_to_bufferv('png', [], [])
                    icon = 'data:image/png;base64,' + base64.b64encode(data).decode()
            except Exception:
                pass
            entries.append(dict(id=app_id, name=app.get_display_name(), icon=icon))
        self.window = Gtk.ApplicationWindow(application=self, title='Applications')
        self.window.set_decorated(False)
        self.window.fullscreen()
        self.window.connect('destroy', self.closed)
        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler('launcher')
        manager.connect('script-message-received::launcher', self.message)
        view = WebKit2.WebView.new_with_user_content_manager(manager)
        self.window.add(view)
        html = (ROOT / 'client/launchpad.html').read_text()
        # JSON is embedded as data, never as executable app commands.
        data = json.dumps(entries).replace('<', '\\u003c')
        wallpaper = base64.b64encode((ROOT / 'profiles/xfce-macos/wallpaper.svg').read_bytes()).decode()
        html = html.replace('__APPS__', data).replace('__WALLPAPER__', wallpaper)
        view.load_html(html, None)
        self.window.show_all()

    def closed(self, *_):
        self.window = None

    def message(self, manager, result):
        try:
            request = json.loads(result.get_js_value().to_string())
            if request.get('action') == 'close':
                self.window.destroy()
            elif request.get('action') == 'launch' and request.get('id') in self.apps:
                context = self.window.get_display().get_app_launch_context()
                self.apps[request['id']].launch([], context)
                self.window.destroy()
        except Exception as error:
            dialog = Gtk.MessageDialog(transient_for=self.window, modal=True,
                                       message_type=Gtk.MessageType.ERROR,
                                       buttons=Gtk.ButtonsType.CLOSE,
                                       text='Could not open application')
            dialog.format_secondary_text(str(error))
            dialog.run()
            dialog.destroy()


if __name__ == '__main__':
    Launchpad().run()
