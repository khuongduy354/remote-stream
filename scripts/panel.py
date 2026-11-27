#!/usr/bin/env python3
"""Local host panel for starting, stopping, and sharing viewer links."""
import json
import ipaddress
import os
from pathlib import Path
import socket
import subprocess
import webbrowser
from urllib.parse import urlsplit
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.state'
SERVICE = 'remote-stream.service'

class Panel(Gtk.Window):
    def __init__(self):
        super().__init__(title='Remote Stream')
        self.set_name('remote-panel')
        self.set_default_size(580, 530)
        self.set_border_width(28)
        self.connect('destroy', Gtk.main_quit)
        css = Gtk.CssProvider()
        css.load_from_data(b"""
            #remote-panel { background: #101923; color: #edf4fa; }
            #remote-panel label { color: #edf4fa; font-size: 15px; }
            #remote-panel entry { background: #1b2938; color: #edf4fa;
                border: 1px solid #43576b; border-radius: 8px; padding: 10px; }
            #remote-panel button { background-image: none; background: #253c50;
                color: #edf4fa; border: 1px solid #43576b; border-radius: 8px;
                padding: 10px 16px; font-size: 15px; text-shadow: none; box-shadow: none; }
            #remote-panel button:hover { background: #35536d; }
            #remote-panel button.suggested-action { background: #18786f; border-color: #21968a; }
            #remote-panel checkbutton { color: #edf4fa; padding: 6px 0; }
        """)
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        self.add(box)
        title = Gtk.Label(xalign=0)
        title.set_markup('<span size="26000" weight="bold">Remote Stream</span>')
        box.pack_start(title, False, False, 0)
        self.status = Gtk.Label(label='Checking server…', xalign=0)
        box.pack_start(self.status, False, False, 0)
        self.running = False
        self.server_button = Gtk.Button(label='Start sharing')
        self.server_button.get_style_context().add_class('suggested-action')
        self.server_button.connect('clicked', lambda _: self.service('stop' if self.running else 'start'))
        box.pack_start(self.server_button, False, False, 0)
        self.vpn_link = self.link_section(box, 'Tailscale · connect from anywhere on your VPN', self.tailscale_url(), self.open_tailscale)
        self.link = self.link_section(box, 'Local network · same Wi-Fi or LAN', self.viewer_url(), self.open_viewer)
        self.audio = Gtk.CheckButton(label='Share system audio')
        self.audio.set_active('AUDIO=1' in self.env_text())
        self.audio.connect('toggled', self.toggle_audio)
        box.pack_start(self.audio, False, False, 0)
        self.message = Gtk.Label(label='Open a link. Mouse and keyboard work automatically.\nNo password. Anyone who can reach this PC can control it.\nStop sharing to end access.', xalign=0)
        self.message.set_line_wrap(True)
        box.pack_start(self.message, False, False, 0)
        GLib.timeout_add_seconds(1, self.refresh)
        self.refresh()

    def link_section(self, box, label, url, action):
        section = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        section.pack_start(Gtk.Label(label=label, xalign=0), False, False, 0)
        entry = Gtk.Entry()
        entry.set_text(url)
        entry.set_placeholder_text('Link not configured')
        entry.set_editable(False)
        section.pack_start(entry, False, False, 0)
        row = Gtk.Box(spacing=8)
        for name, callback in [('Open', action), ('Copy link', lambda: self.copy(entry.get_text()))]:
            button = Gtk.Button(label=name)
            button.set_sensitive(bool(url))
            button.connect('clicked', lambda _, fn=callback: fn())
            row.pack_start(button, True, True, 0)
        section.pack_start(row, False, False, 0)
        box.pack_start(section, False, False, 0)
        return entry

    def env_text(self):
        try: return (STATE / 'service.env').read_text()
        except FileNotFoundError: return ''

    def viewer_url(self):
        for line in self.env_text().splitlines():
            if line.startswith('PUBLIC_ORIGIN='): return line.split('=', 1)[1]
        return 'http://localhost:8787'

    def tailscale_url(self):
        # Use an origin already allowed by the streaming server.
        for line in self.env_text().splitlines():
            if line.startswith(('PUBLIC_ORIGIN=', 'EXTRA_ORIGINS=')):
                for origin in line.split('=', 1)[1].split(','):
                    try:
                        if ipaddress.ip_address(urlsplit(origin.strip()).hostname) in ipaddress.ip_network('100.64.0.0/10'):
                            return origin.strip()
                    except ValueError:
                        pass
        return ''

    def open_tailscale(self):
        if self.vpn_link.get_text():
            self.service('start')
            webbrowser.open(self.vpn_link.get_text())
        else:
            self.message.set_text('Configure the Tailscale origin in .state/service.env first.')

    def copy(self, text):
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        clipboard.set_text(text, -1)
        clipboard.store()
        self.message.set_text('Link copied. Open it in a browser to connect.')

    def open_viewer(self):
        self.service('start')
        webbrowser.open(self.link.get_text())

    def service(self, action):
        result = subprocess.run(['systemctl', '--user', action, SERVICE], capture_output=True, text=True, timeout=10)
        self.message.set_text(result.stderr.strip() if result.returncode else f'Server {action} requested.')
        self.refresh()

    def control(self, command):
        try:
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(1)
                connection.connect(str(STATE / 'control.sock'))
                connection.sendall((command + '\n').encode())
                result = json.loads(connection.recv(4096))
            return result
        except (OSError, ValueError):
            if command != 'status': self.message.set_text('Server is not running.')
            return None

    def refresh(self):
        result = self.control('status')
        self.running = bool(result)
        if not result: text = 'Sharing is off'
        elif result['connected']: text = 'Sharing is on · viewer connected'
        else: text = 'Sharing is on · ready to connect'
        self.status.set_text(text)
        self.server_button.set_label('Stop sharing' if self.running else 'Start sharing')
        return True

    def toggle_audio(self, _):
        lines = [line for line in self.env_text().splitlines() if not line.startswith('AUDIO=')]
        lines.append('AUDIO=' + ('1' if self.audio.get_active() else '0'))
        (STATE / 'service.env').write_text('\n'.join(lines) + '\n')
        os.chmod(STATE / 'service.env', 0o600)
        if self.running:
            self.service('restart')

if __name__ == '__main__':
    Panel().show_all()
    Gtk.main()
