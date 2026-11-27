"""Verify the production WebKit wrapper renders the same HTML dashboard."""
import json
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
from panel import Panel, STATE, Gtk, Gdk, dashboard
import panel as panel_module
from gi.repository import GLib

info, child = dashboard()
assert child is None, 'Expected existing dashboard bridge to be reused'
opened = []
panel_module.webbrowser.open = lambda url: opened.append(url)
panel = Panel(info)
panel.show_all()
result = {}

def evaluated(view, response, _):
    try:
        result['value'] = view.evaluate_javascript_finish(response).to_string()
    except Exception as error:
        result['error'] = str(error)

def evaluate(script):
    result.clear()
    panel.webview.evaluate_javascript(script, -1, None, None, None, evaluated, None)
    deadline = time.monotonic() + 4
    while not result and time.monotonic() < deadline:
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        time.sleep(.03)
    return result.get('value', '')

try:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        value = evaluate("JSON.stringify({title:document.title,cards:document.querySelectorAll('.screen').length})")
        if value and json.loads(value).get('cards') == 1:
            break
        time.sleep(.1)
    else:
        raise AssertionError('WebKit did not render the dashboard: ' + str(result))
    assert evaluate("document.querySelector('#new-desktop').click(); document.querySelector('#create-dialog').open.toString()") == 'true'
    assert evaluate("document.querySelector('#desktop-size').checkVisibility().toString()") == 'false'
    evaluate("document.querySelector('#create-dialog').close(); window.webkit.messageHandlers.clipboard.postMessage('http://127.0.0.1/invite-test'); 'sent'")
    assert Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text() == 'http://127.0.0.1/invite-test'
    evaluate("document.querySelector('.open-screen').click(); 'opened'")
    deadline = time.monotonic() + 4
    while not opened and time.monotonic() < deadline:
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        time.sleep(.03)
    assert opened and '#token=' in opened[0], 'Open did not launch the viewer'
    assert panel.webview.get_uri().startswith(info['origin']), 'Viewer replaced the admin dashboard'
    print('PASS: native WebKit dashboard, create dialog, progressive disclosure and native clipboard.', flush=True)
finally:
    panel.hide()
