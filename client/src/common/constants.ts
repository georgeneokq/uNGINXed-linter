// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';

const folderName = path.basename(__dirname);
export const EXTENSION_ROOT_DIR =
    folderName === 'common' ? path.dirname(path.dirname(path.dirname(__dirname))) : path.dirname(__dirname);
export const SERVER_SCRIPT_PATH = path.join(EXTENSION_ROOT_DIR, 'server', 'tool', `server.py`);
export const DEBUG_SERVER_SCRIPT_PATH = path.join(EXTENSION_ROOT_DIR, 'server', 'tool', `_debug_server.py`);
