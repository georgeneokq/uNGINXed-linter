// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { exec, ExecException, spawnSync } from 'child_process';
import { LanguageClient } from 'vscode-languageclient/node';
import { registerLogger, traceError, traceLog, traceVerbose } from './common/log/logging';
import {
    checkVersion,
    getInterpreterDetails,
    resolveInterpreter,
} from './common/python';
import { restartServer } from './common/server';
import { checkIfConfigurationChanged, getInterpreterFromSetting } from './common/settings';
import { loadServerDefaults } from './common/setup';
import { getLSClientTraceLevel, getProjectRoot } from './common/utilities';
import { createOutputChannel, onDidChangeConfiguration, registerCommand } from './common/vscodeapi';
import * as os from 'os';

interface ExecReturn {
    err: ExecException
    stdout: string
    stderr: string
}

const execAsync: (command: string) => Promise<ExecReturn> = (command: string) => (new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr })
    })
}))

const REQUIRED_PACKAGES = [
    'crossplane',
    'jinja2',
    'xhtml2pdf',
    'pygls'
]


let lsClient: LanguageClient | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const isWindows = os.platform() === 'win32'

    const pythonPath = (await getInterpreterDetails()).path[0]
    const setupScriptPath = vscode.Uri.joinPath(context.extensionUri, 'tools', 'build-python.py')

    vscode.window.showInformationMessage('Initialising Extension...')
    const pythonSubprocess = spawnSync(pythonPath, [setupScriptPath.fsPath, context.extensionUri.fsPath])
    if (pythonSubprocess.stderr.toString()){
        vscode.window.showErrorMessage(`Unable to activate extension. Error: ${pythonSubprocess.stderr.toString()}`)
        console.log(pythonSubprocess.stderr.toString())
    }

    vscode.window.showInformationMessage('Initialisation Complete!')    

    // Prepare venv URI and paths
    const venvUri = vscode.Uri.joinPath(context.extensionUri, 'venv')
    let venvScriptsUri = vscode.Uri.joinPath(venvUri, 'bin')

    if(isWindows){
        venvScriptsUri = vscode.Uri.joinPath(venvUri, 'Scripts')
    }

    let interpreter = 'python'
    if(isWindows) {
        interpreter = 'python.exe'
    }

    const venvPythonUri = vscode.Uri.joinPath(venvScriptsUri, interpreter)
    const venvPythonPath = venvPythonUri.fsPath
    
    // This is required to get server name and module. This should be
    // the first thing that we do in this extension.
    const serverInfo = loadServerDefaults();
    const serverName = serverInfo.name;
    const serverId = serverInfo.module;

    // Setup logging
    const outputChannel = createOutputChannel(serverName);
    context.subscriptions.push(outputChannel, registerLogger(outputChannel));

    const changeLogLevel = async (c: vscode.LogLevel, g: vscode.LogLevel) => {
        const level = getLSClientTraceLevel(c, g);
        await lsClient?.setTrace(level);
    };

    context.subscriptions.push(
        outputChannel.onDidChangeLogLevel(async (e) => {
            await changeLogLevel(e, vscode.env.logLevel);
        }),
        vscode.env.onDidChangeLogLevel(async (e) => {
            await changeLogLevel(outputChannel.logLevel, e);
        }),
        vscode.commands.registerTextEditorCommand('unginxed.generatePDF', async (textEditor, _) => {
            // Create directory to write PDF
            const workspaceDir = vscode.workspace.workspaceFolders[0].uri
            const outputUri = vscode.Uri.joinPath(workspaceDir, 'output', 'unginxed')
            const outputDir = outputUri.fsPath
            vscode.workspace.fs.createDirectory(outputUri)

            // Execute command to write PDF
            const openEditorFilePath = textEditor.document.fileName

            const command = `${venvPythonPath} -m unginxed ${openEditorFilePath} --pdf-output=${outputDir}`

            // Currently only tested for windows
            exec(command, (err, stdout, stderr) => {
                if(err)
                    vscode.window.showErrorMessage(`Unable to generate PDF. Error: ${stderr}`)
                else
                    vscode.window.showInformationMessage(`Report generated at ${outputDir}`)
            })
        })
    );

    traceLog(`Name: ${serverName}`);
    traceLog(`Module: ${serverInfo.module}`);
    traceVerbose(`Configuration: ${JSON.stringify(serverInfo)}`);

    const runServer = async () => {
        lsClient = await restartServer(venvPythonPath, serverId, serverName, outputChannel, lsClient);
    };

    context.subscriptions.push(
        onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
            if (checkIfConfigurationChanged(e, serverId)) {
                await runServer();
            }
        }),
        registerCommand(`${serverId}.restart`, async () => {
            await runServer();
        }),
    );

    await runServer()
}

export async function deactivate(): Promise<void> {
    if (lsClient) {
        await lsClient.stop();
    }
}
