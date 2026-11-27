#!/usr/bin/env python3
"""A self-contained Xfce preset; never overwrite the host's desktop settings."""
import os
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent


def prop(parent, name, kind, value=None):
    attrs = {'name': name, 'type': kind}
    if value is not None:
        attrs['value'] = str(value).lower() if isinstance(value, bool) else str(value)
    return ET.SubElement(parent, 'property', attrs)


def array(parent, name, values, kind='int'):
    item = prop(parent, name, 'array')
    for value in values:
        ET.SubElement(item, 'value', {'type': kind, 'value': str(value)})
    return item


def write_channel(config, name, build):
    root = ET.Element('channel', {'name': name, 'version': '1.0'})
    build(root)
    target = config / 'xfce4/xfconf/xfce-perchannel-xml' / (name + '.xml')
    target.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(root)
    ET.ElementTree(root).write(target, encoding='UTF-8', xml_declaration=True)


def prepare(base):
    config, cache = base / 'config', base / 'cache'
    config.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    if (config / '.preset-ready').exists():
        return config, cache
    wallpaper = ROOT / 'profiles/xfce-macos/wallpaper.svg'

    def panels(root):
        prop(root, 'configver', 'int', 2)
        panels = array(root, 'panels', [1, 2])
        prop(panels, 'dark-mode', 'bool', False)
        for number, position, size, length, plugins in [(1, 'p=6;x=0;y=0', 30, 100, [1, 2, 3, 4]), (2, 'p=10;x=0;y=0', 58, 1, [11, 12, 13, 14, 15, 16, 17])]:
            panel = prop(panels, 'panel-' + str(number), 'empty')
            for name, kind, value in [('position', 'string', position), ('position-locked', 'bool', True), ('size', 'uint', size), ('length', 'uint', length), ('length-adjust', 'bool', True), ('autohide-behavior', 'uint', 0), ('icon-size', 'uint', 18 if number == 1 else 40)]:
                prop(panel, name, kind, value)
            array(panel, 'plugin-ids', plugins)
        plugins = prop(root, 'plugins', 'empty')
        menu = prop(plugins, 'plugin-1', 'string', 'applicationsmenu')
        prop(menu, 'button-title', 'string', 'Applications')
        prop(menu, 'show-button-title', 'bool', True)
        prop(menu, 'button-icon', 'string', 'view-grid-symbolic')
        spacer = prop(plugins, 'plugin-2', 'string', 'separator')
        prop(spacer, 'expand', 'bool', True); prop(spacer, 'style', 'uint', 0)
        prop(plugins, 'plugin-3', 'string', 'systray')
        clock = prop(plugins, 'plugin-4', 'string', 'clock')
        prop(clock, 'digital-format', 'string', '%a %d %b  %H:%M')
        commands = [
            ('Files', 'Thunar', 'org.xfce.thunar'),
            ('Browser', f'google-chrome --user-data-dir="{base / "browser"}" --no-first-run --new-window', 'google-chrome'),
            ('Terminal', 'xfce4-terminal --disable-server', 'org.xfce.terminal'),
            ('Settings', 'xfce4-settings-manager', 'org.xfce.settings.manager'),
            ('Applications', f'/usr/bin/python3 "{ROOT / "scripts/launchpad.py"}"', 'view-grid-symbolic'),
        ]
        for index, (name, command, icon) in enumerate(commands, 11):
            directory = config / 'xfce4/panel' / ('launcher-' + str(index))
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / 'app.desktop'
            target.write_text(f'[Desktop Entry]\nType=Application\nName={name}\nExec={command}\nIcon={icon}\nTerminal=false\n')
            plugin = prop(plugins, 'plugin-' + str(index), 'string', 'launcher')
            array(plugin, 'items', [target], 'string')
        prop(plugins, 'plugin-16', 'string', 'separator')
        tasks = prop(plugins, 'plugin-17', 'string', 'tasklist')
        prop(tasks, 'show-labels', 'bool', False)
        prop(tasks, 'grouping', 'uint', 1)
        prop(tasks, 'flat-buttons', 'bool', True)

    def appfinder(root):
        for name, kind, value in [('icon-view', 'bool', True), ('hide-category-pane', 'bool', True), ('text-beside-icons', 'bool', False), ('item-icon-size', 'uint', 5), ('always-center', 'bool', True)]:
            prop(root, name, kind, value)
        last = prop(root, 'last', 'empty')
        prop(last, 'window-width', 'int', 1000)
        prop(last, 'window-height', 'int', 620)

    def appearance(root):
        net = prop(root, 'Net', 'empty')
        prop(net, 'ThemeName', 'string', 'Adwaita')
        prop(net, 'IconThemeName', 'string', 'Adwaita')
        gtk = prop(root, 'Gtk', 'empty')
        prop(gtk, 'FontName', 'string', 'Noto Sans 10')
        prop(gtk, 'MonospaceFontName', 'string', 'Monospace 10')
        prop(gtk, 'DecorationLayout', 'string', 'close,minimize,maximize:')
        prop(gtk, 'CursorThemeName', 'string', 'Adwaita')
        prop(gtk, 'ApplicationPreferDarkTheme', 'bool', False)

    def window_manager(root):
        general = prop(root, 'general', 'empty')
        for name, kind, value in [('theme', 'string', 'Default'), ('button_layout', 'string', 'CHM|'), ('title_alignment', 'string', 'center'), ('title_font', 'string', 'Noto Sans Bold 10'), ('workspace_count', 'int', 4), ('use_compositing', 'bool', False), ('focus_new', 'bool', True)]:
            prop(general, name, kind, value)

    def desktop(root):
        icons = prop(root, 'desktop-icons', 'empty')
        prop(icons, 'style', 'int', 0)
        backdrop = prop(root, 'backdrop', 'empty')
        prop(backdrop, 'single-workspace-mode', 'bool', True)
        screen = prop(backdrop, 'screen0', 'empty')
        # Xvfb exposes one RandR monitor named screen. Include the legacy fallback.
        for monitor_name in ['monitorscreen', 'monitor0']:
            monitor = prop(screen, monitor_name, 'empty')
            for number in range(4):
                workspace = prop(monitor, 'workspace' + str(number), 'empty')
                prop(workspace, 'last-image', 'string', wallpaper)
                prop(workspace, 'image-style', 'int', 5)
                prop(workspace, 'color-style', 'int', 0)

    def session(root):
        general = prop(root, 'general', 'empty')
        prop(general, 'SaveOnExit', 'bool', False)
        prop(general, 'FailsafeSessionName', 'string', 'Failsafe')
        prop(general, 'PromptOnLogout', 'bool', True)

    write_channel(config, 'xfce4-panel', panels)
    write_channel(config, 'xsettings', appearance)
    write_channel(config, 'xfce4-appfinder', appfinder)
    write_channel(config, 'xfwm4', window_manager)
    write_channel(config, 'xfce4-desktop', desktop)
    write_channel(config, 'xfce4-session', session)
    gtk = config / 'gtk-3.0'; gtk.mkdir(exist_ok=True)
    (gtk / 'settings.ini').write_text('[Settings]\ngtk-theme-name=Adwaita\ngtk-icon-theme-name=Adwaita\ngtk-decoration-layout=close,minimize,maximize:\ngtk-application-prefer-dark-theme=false\n')
    (gtk / 'gtk.css').write_text('.xfce4-panel { background-color: #f4f5f7; color: #242b35; }\n.xfce4-panel button { border-radius: 8px; }\n')
    # A remote desktop should not start extra host power, lock, keyring or network agents.
    autostart = config / 'autostart'; autostart.mkdir(exist_ok=True)
    for entry in Path('/etc/xdg/autostart').glob('*.desktop'):
        if entry.name not in ('xfsettingsd.desktop', 'at-spi-dbus-bus.desktop'):
            (autostart / entry.name).write_text('[Desktop Entry]\nType=Application\nHidden=true\n')
    (config / '.preset-ready').touch()
    return config, cache


if __name__ == '__main__':
    if '--install' in sys.argv:
        target = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'xsessions/xfce-macos.desktop'
        target.parent.mkdir(parents=True, exist_ok=True)
        script = str(Path(__file__).resolve()).replace('\\', '\\\\').replace('"', '\\"')
        target.write_text(f'[Desktop Entry]\nName=xfce macos\nComment=Xfce with a macOS-inspired layout and separate settings\nExec=/usr/bin/python3 "{script}"\nTryExec=xfce4-session\nType=Application\n')
        print('Installed desktop preset: xfce macos')
        raise SystemExit(0)
    directory = os.environ.get('REMOTE_STREAM_SESSION_DIR')
    # Existing hosts also expose their private session directory through Xauthority.
    auth = Path(os.environ.get('XAUTHORITY', ''))
    if not directory and auth.name == 'Xauthority' and auth.parent.parent.name == 'desktops':
        directory = str(auth.parent)
    base = (Path(directory) / 'xfce-macos') if directory else (Path.home() / '.local/share/remote-stream/xfce-macos')
    config, cache = prepare(base)
    os.environ.update(XDG_CONFIG_HOME=str(config), XDG_CACHE_HOME=str(cache), XDG_CURRENT_DESKTOP='XFCE', XDG_SESSION_DESKTOP='xfce', DESKTOP_SESSION='xfce')
    # Start the bus after setting XDG paths so activated xfconfd uses this profile too.
    os.environ.pop('DBUS_SESSION_BUS_ADDRESS', None)
    os.execv('/usr/bin/dbus-run-session', ['dbus-run-session', '--', '/usr/bin/xfce4-session'])
