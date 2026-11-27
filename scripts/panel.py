#!/usr/bin/env python3
"""Open the local HTML dashboard in a native WebKit window."""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import urllib.request
from urllib.parse import urlsplit
import webbrowser
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

ROOT = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get('STATE_DIR', ROOT / '.state'))


def dashboard():
    """Reuse a live owner-only dashboard, or start a bridge over a private pipe."""
    try:
        info = json.loads((STATE / 'dashboard.json').read_text())
        address = urlsplit(info['origin'])
        if address.scheme != 'http' or address.hostname != '127.0.0.1':
            raise ValueError('Invalid local dashboard')
        request = urllib.request.Request(info['origin'] + '/api/health', headers={'Authorization': 'Bearer ' + info['token']})
        with urllib.request.urlopen(request, timeout=1) as response:
            if response.status == 200:
                return info, None
    except (OSError, ValueError, KeyError):
        pass
    node = shutil.which('node') or str(Path.home() / '.local/bin/node')
    child = subprocess.Popen([node, str(ROOT / 'scripts/dashboard.js')], stdout=subprocess.PIPE, text=True,
                             env={**os.environ, 'STATE_DIR': str(STATE)})
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        if not selector.select(10):
            child.terminate()
            raise RuntimeError('Dashboard did not start')
    try:
        info = json.loads(child.stdout.readline())
        return info, child
    except Exception:
        child.terminate()
        raise RuntimeError('Could not start the dashboard. Check the service log.')


class Panel(Gtk.Window):
    def __init__(self, info):
        super().__init__(title='Remote Stream')
        gi.require_version('WebKit2', '4.1')
        from gi.repository import WebKit2
        self.set_default_size(1120, 820)
        self.set_name('remote-panel')
        self.origin = info['origin']
        self.connect('destroy', Gtk.main_quit)
        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler('clipboard')
        manager.connect('script-message-received::clipboard', self.copy_invite)
        self.webview = WebKit2.WebView.new_with_user_content_manager(manager)
        self.webview.get_settings().set_enable_write_console_messages_to_stdout(False)
        self.webview.connect('decide-policy', self.navigate)
        self.add(self.webview)
        self.webview.load_uri(info['origin'] + '/#key=' + info['token'])

    def copy_invite(self, manager, result):
        text = result.get_js_value().to_string()
        if len(text) > 8192 or urlsplit(text).scheme not in ('http', 'https'):
            return
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        clipboard.set_text(text, -1)
        clipboard.store()

    def navigate(self, view, decision, decision_type):
        from gi.repository import WebKit2
        if decision_type not in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        parsed = urlsplit(uri)
        if f'{parsed.scheme}://{parsed.netloc}' == self.origin:
            return False
        decision.ignore()
        if parsed.scheme in ('http', 'https'):
            webbrowser.open(uri)
        return True


if __name__ == '__main__':
    info, child = dashboard()
    try:
        try:
            window = Panel(info)
        except (ValueError, ImportError):
            # Browser mode still provides the full HTML UI without WebKitGTK.
            webbrowser.open(info['origin'] + '/#key=' + info['token'])
            if child:
                child.wait()
        else:
            window.show_all()
            Gtk.main()
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
