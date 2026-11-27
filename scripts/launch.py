#!/usr/bin/env python3
"""Launch or focus Remote Stream from dmenu and desktop launchers."""
import json
import os
from pathlib import Path
import subprocess


def focus_existing():
    try:
        tree = json.loads(subprocess.check_output(['i3-msg', '-t', 'get_tree'], text=True, timeout=2))
        windows = []
        def visit(node):
            if node.get('window') and node.get('name') == 'Remote Stream':
                windows.append(node['id'])
            for child in node.get('nodes', []) + node.get('floating_nodes', []):
                visit(child)
        visit(tree)
        if windows:
            result = subprocess.run(['i3-msg', f'[con_id={windows[-1]}] focus'], capture_output=True, timeout=2)
            return result.returncode == 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return False


if __name__ == '__main__':
    subprocess.run(['systemctl', '--user', 'start', 'remote-stream.service'], capture_output=True, timeout=15)
    if not focus_existing():
        result = subprocess.run(['systemctl', '--user', 'start', 'remote-stream-panel.service'], capture_output=True, timeout=15)
        if result.returncode:
            os.execv('/usr/bin/python3', ['python3', str(Path(__file__).with_name('panel.py'))])
