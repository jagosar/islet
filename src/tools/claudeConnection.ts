// SPDX-License-Identifier: GPL-2.0-or-later
// islet-claude: connects Islet to Claude Code, or disconnects it, from the command line.
// Used by the uninstaller so Claude Code is left exactly as it was.
//
//   gjs -m tools/claudeConnection.js status|connect|disconnect
//
// Exit codes: 0 done, 1 settings.json could not be changed (message on stderr), 2 usage.

import GLib from 'gi://GLib';
import System from 'system';

import {ClaudeConnection} from '../services/claudeConnection.js';

const extensionDir = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const connection = new ClaudeConnection(extensionDir);
const command = System.programArgs[0];

try {
    switch (command) {
    case 'status': {
        const {hooks, statusLine} = connection.status();
        print(`${connection.path}: hooks ${hooks ? 'connected' : 'not connected'}, status line ${statusLine ? 'connected' : 'not connected'}`);
        break;
    }
    case 'connect':
        connection.connect();
        print(`Connected Islet to Claude Code (${connection.path}).`);
        break;
    case 'disconnect':
        connection.disconnect();
        print(`Disconnected Islet from Claude Code (${connection.path}).`);
        break;
    default:
        printerr('Usage: gjs -m tools/claudeConnection.js status|connect|disconnect');
        System.exit(2);
    }
} catch (error) {
    printerr(`Islet: ${error instanceof Error ? error.message : error}`);
    System.exit(1);
}
