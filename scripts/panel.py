#!/usr/bin/env python3
"""Local session manager. Administrative commands never cross the network."""
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import webbrowser
from urllib.parse import urlencode
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib

ROOT = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get('STATE_DIR', ROOT / '.state'))
SERVICE = 'remote-stream.service'

class Panel(Gtk.Window):
    def __init__(self):
        super().__init__(title='Remote Stream · Sessions')
        self.set_name('remote-panel')
        self.set_default_size(730, 690)
        self.set_border_width(20)
        self.connect('destroy', Gtk.main_quit)
        self.sessions = {}
        self.running = False
        self.busy = False
        self.refreshing = False
        self.updating = False
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.add(box)
        title = Gtk.Label(xalign=0)
        title.set_markup('<span size="22000" weight="bold">Remote Stream</span>')
        box.pack_start(title, False, False, 0)
        self.status = Gtk.Label(label='Checking server…', xalign=0)
        box.pack_start(self.status, False, False, 0)
        row = Gtk.Box(spacing=8)
        self.server_button = self.button(row, 'Start server', self.toggle_server)
        self.new_button = self.button(row, 'New desktop', self.create_dialog)
        box.pack_start(row, False, False, 0)
        box.pack_start(Gtk.Label(label='Desktop', xalign=0), False, False, 0)
        self.session = Gtk.ComboBoxText()
        self.session.connect('changed', self.selection_changed)
        box.pack_start(self.session, False, False, 0)
        self.details = Gtk.Label(xalign=0)
        self.details.set_line_wrap(True)
        box.pack_start(self.details, False, False, 0)
        self.audio = Gtk.CheckButton(label='Stream this desktop’s audio')
        self.audio.connect('toggled', self.toggle_audio)
        box.pack_start(self.audio, False, False, 0)
        row = Gtk.Box(spacing=8)
        self.open_button = self.button(row, 'Open desktop', self.open_viewer)
        self.end_button = self.button(row, 'End desktop…', self.end_dialog)
        box.pack_start(row, False, False, 0)
        box.pack_start(Gtk.Separator(), False, False, 0)
        box.pack_start(Gtk.Label(label='Share selected desktop', xalign=0), False, False, 0)
        row = Gtk.Box(spacing=8)
        self.network = Gtk.ComboBoxText()
        for value in self.origins():
            self.network.append(value, value)
        self.network.set_active(0)
        self.network.connect('changed', lambda _: self.update_link())
        row.pack_start(self.network, True, True, 0)
        self.role = Gtk.ComboBoxText()
        self.role.append('view', 'View only')
        self.role.append('control', 'Can control')
        self.role.set_active_id('control')
        self.role.connect('changed', lambda _: self.update_link())
        row.pack_start(self.role, False, False, 0)
        box.pack_start(row, False, False, 0)
        self.link = Gtk.Entry()
        self.link.set_editable(False)
        self.link.set_placeholder_text('Select a desktop')
        box.pack_start(self.link, False, False, 0)
        row = Gtk.Box(spacing=8)
        self.copy_button = self.button(row, 'Copy invite', self.copy_link)
        self.rotate_button = self.button(row, 'Revoke all invites…', self.rotate_dialog)
        box.pack_start(row, False, False, 0)
        box.pack_start(Gtk.Separator(), False, False, 0)
        box.pack_start(Gtk.Label(label='Connected viewers · control requests appear here', xalign=0), False, False, 0)
        self.viewers = Gtk.ComboBoxText()
        box.pack_start(self.viewers, False, False, 0)
        row = Gtk.Box(spacing=8)
        self.button(row, 'Give control', lambda: self.act('grant', viewer=self.viewers.get_active_id()))
        self.button(row, 'Release control', lambda: self.act('revoke'))
        self.button(row, 'Disconnect viewer', lambda: self.act('disconnect', viewer=self.viewers.get_active_id()))
        box.pack_start(row, False, False, 0)
        self.message = Gtk.Label(label='Separate desktops have independent input. Shared viewers take turns controlling one desktop.', xalign=0)
        self.message.set_line_wrap(True)
        box.pack_start(self.message, False, False, 0)
        GLib.timeout_add_seconds(2, self.refresh)
        self.refresh()

    def button(self, row, title, callback):
        button = Gtk.Button(label=title)
        button.connect('clicked', lambda _: callback())
        row.pack_start(button, True, True, 0)
        return button

    def origins(self):
        values = []
        try:
            for line in (STATE / 'service.env').read_text().splitlines():
                if line.startswith(('PUBLIC_ORIGIN=', 'EXTRA_ORIGINS=')):
                    values.extend(value.strip() for value in line.split('=', 1)[1].split(',') if value.strip())
        except FileNotFoundError:
            pass
        return list(dict.fromkeys(values or [os.environ.get('PUBLIC_ORIGIN', 'http://localhost:8787')]))

    def control(self, request):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(20)
            connection.connect(str(STATE / 'control.sock'))
            connection.sendall((json.dumps(request) + '\n').encode())
            data = b''
            while b'\n' not in data:
                chunk = connection.recv(8192)
                if not chunk:
                    raise OSError('Server disconnected')
                data += chunk
                if len(data) > 262144:
                    raise OSError('Server response too large')
        return json.loads(data)

    def async_call(self, work, complete):
        def run():
            try: result, error = work(), None
            except Exception as exc: result, error = None, str(exc)
            GLib.idle_add(complete, result, error)
        threading.Thread(target=run, daemon=True).start()

    def refresh(self):
        if self.busy or self.refreshing:
            return True
        self.refreshing = True
        def complete(result, error):
            self.refreshing = False
            if not self.busy:
                self.render(result if not error else None)
            return False
        self.async_call(lambda: self.control({'action': 'status'}), complete)
        return True

    def render(self, result, selected=None):
        self.running = bool(result and not result.get('error'))
        self.server_button.set_label('Stop server…' if self.running else 'Start server')
        self.status.set_text(f"Server running · {len(result.get('sessions', []))} desktops" if self.running else 'Server stopped')
        self.new_button.set_sensitive(self.running and bool(result.get('virtualAvailable')) and not self.busy)
        if self.running and not result.get('virtualAvailable'):
            self.message.set_text('Install Xvfb, i3, xauth and dbus-run-session to create desktops.')
        selected = selected or self.session.get_active_id()
        self.sessions = {s['id']: s for s in result.get('sessions', [])} if self.running else {}
        self.updating = True
        self.session.remove_all()
        for item in self.sessions.values():
            self.session.append(item['id'], item['name'])
        if selected in self.sessions: self.session.set_active_id(selected)
        else: self.session.set_active(0)
        self.updating = False
        self.selection_changed()

    def selection_changed(self, *_):
        if self.updating: return
        item = self.sessions.get(self.session.get_active_id())
        self.updating = True
        self.audio.set_active(bool(item and item.get('audio')))
        self.audio.set_sensitive(bool(item and item.get('audioSource')))
        self.updating = False
        self.open_button.set_sensitive(bool(item))
        self.end_button.set_sensitive(bool(item and item['kind'] == 'virtual'))
        self.copy_button.set_sensitive(bool(item))
        self.rotate_button.set_sensitive(bool(item))
        self.details.set_text('Select or create a desktop.' if not item else
            f"{item['screen']['width']} × {item['screen']['height']} · " +
            ('Main display · shares local input' if item['kind'] == 'host' else 'Independent desktop · software graphics · same Linux account') +
            (' · audio on' if item.get('audio') else ' · audio off') +
            (f"\n{item['lastError']}" if item.get('lastError') else ''))
        selected = self.viewers.get_active_id()
        self.viewers.remove_all()
        for viewer in item.get('viewers', []) if item else []:
            status = 'CONTROLLING' if viewer['controlling'] else 'REQUESTING' if viewer['requesting'] else viewer['role']
            self.viewers.append(viewer['id'], f"{viewer['name']} · {status}")
        if selected: self.viewers.set_active_id(selected)
        if self.viewers.get_active() < 0: self.viewers.set_active(0)
        self.update_link()

    def invite(self, role=None):
        item = self.sessions.get(self.session.get_active_id())
        if not item: return ''
        origin = self.network.get_active_id()
        return f"{origin}/?{urlencode({'session': item['id']})}#token={item['tokens'][role or self.role.get_active_id()]}"

    def update_link(self):
        if hasattr(self, 'link'): self.link.set_text(self.invite())

    def toggle_audio(self, *_):
        if not self.updating:
            self.act('audio', enabled=self.audio.get_active())

    def copy_link(self):
        text = self.invite()
        if not text: return
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        clipboard.set_text(text, -1)
        clipboard.store()
        self.message.set_text('Invite copied. Anyone with this link has its selected access until revoked or server restart.')

    def open_viewer(self):
        url = self.invite('control')
        if url: webbrowser.open(url)

    def act(self, action, **kwargs):
        if self.busy: return
        if action in ('grant', 'disconnect') and not kwargs.get('viewer'):
            self.message.set_text('Select a connected viewer first.')
            return
        self.busy = True
        self.message.set_text('Working…')
        request = {'action': action, 'session': self.session.get_active_id(), **kwargs}
        def complete(result, error):
            self.busy = False
            if error or result.get('error'):
                self.message.set_text(error or result['error'])
            else:
                self.render(result, result.get('created'))
                self.message.set_text('Desktop created. Apps stay running when viewers disconnect.' if action == 'create' else 'Updated.')
            return False
        self.async_call(lambda: self.control(request), complete)

    def confirm(self, title, message):
        dialog = Gtk.MessageDialog(transient_for=self, modal=True, message_type=Gtk.MessageType.WARNING,
                                   buttons=Gtk.ButtonsType.OK_CANCEL, text=title)
        dialog.format_secondary_text(message)
        response = dialog.run()
        dialog.destroy()
        return response == Gtk.ResponseType.OK

    def end_dialog(self):
        if self.confirm('End this desktop?', 'All apps in this virtual desktop will close. Unsaved work may be lost.'):
            self.act('end')

    def rotate_dialog(self):
        if self.confirm('Revoke this desktop’s invitations?', 'All viewers will disconnect. Existing links will stop working.'):
            self.act('rotate')

    def toggle_server(self):
        if self.busy: return
        if self.running and not self.confirm('Stop server?', 'All virtual desktops and their apps will close. Main desktop stays running.'):
            return
        action = 'stop' if self.running else 'start'
        self.busy = True
        def work():
            result = subprocess.run(['systemctl', '--user', action, SERVICE], capture_output=True, text=True, timeout=15)
            if result.returncode: raise OSError(result.stderr.strip())
        def complete(result, error):
            self.busy = False
            self.message.set_text(error or f'Server {action} completed.')
            self.refresh()
            return False
        self.async_call(work, complete)

    def create_dialog(self):
        dialog = Gtk.Dialog(title='New independent desktop', transient_for=self, modal=True)
        dialog.add_buttons('Cancel', Gtk.ResponseType.CANCEL, 'Create', Gtk.ResponseType.OK)
        area = dialog.get_content_area()
        area.set_border_width(16)
        area.set_spacing(10)
        entry = Gtk.Entry()
        entry.set_placeholder_text('Desktop name')
        entry.set_text('Work desktop')
        area.add(entry)
        size = Gtk.ComboBoxText()
        for value in ['1280x720', '1920x1080', '2560x1440']:
            size.append(value, value.replace('x', ' × '))
        size.set_active(0)
        area.add(size)
        label = Gtk.Label(label='Independent input and audio. Files share your Linux account.\nSoftware graphics; use main desktop for GPU-heavy games.')
        label.set_line_wrap(True)
        area.add(label)
        dialog.show_all()
        response = dialog.run()
        name, resolution = entry.get_text(), size.get_active_id()
        dialog.destroy()
        if response == Gtk.ResponseType.OK:
            width, height = map(int, resolution.split('x'))
            self.act('create', name=name, width=width, height=height)

if __name__ == '__main__':
    Panel().show_all()
    Gtk.main()
