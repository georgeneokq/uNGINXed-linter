// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { exec, ExecException } from 'child_process';
import { LanguageClient } from 'vscode-languageclient/node';
import { registerLogger, traceError, traceLog, traceVerbose } from './common/log/logging';
import {
    checkVersion,
    getInterpreterDetails,
    initializePython,
    onDidChangePythonInterpreter,
    resolveInterpreter,
    runPythonExtensionCommand,
} from './common/python';
import { restartServer } from './common/server';
import { checkIfConfigurationChanged, getInterpreterFromSetting } from './common/settings';
import { loadServerDefaults } from './common/setup';
import { getLSClientTraceLevel, getProjectRoot } from './common/utilities';
import { createOutputChannel, onDidChangeConfiguration, registerCommand } from './common/vscodeapi';

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
    // Prepare venv URI and paths
    const venvUri = vscode.Uri.joinPath(context.globalStorageUri, 'venv')
    const venvPath = venvUri.fsPath
    const venvScriptsUri = vscode.Uri.joinPath(venvUri, 'Scripts')

    // Currently only supports Windows by using hard-coded .exe extension
    const venvPythonUri = vscode.Uri.joinPath(venvScriptsUri, 'python.exe')
    const venvPythonPath = venvPythonUri.fsPath

    // Python interpreter may be selected some time later
    let pythonInterpreter = (await getInterpreterDetails()).path?.[0]

    const performFirstTimeSetup = async () => {
        // Check if venv already exists (first-time setup has been performed)
        try {
            await vscode.workspace.fs.readDirectory(venvUri)
    
            // Check if all required packages are installed (may have failed halfway)
            const pipFreezeResult = await execAsync(`${venvPythonPath} freeze`)
            const lines = pipFreezeResult.stdout.split('\n')
            const packages = lines.map((line) => line.split('==')[0])
            if(REQUIRED_PACKAGES.some((requiredPackage) => !packages.includes(requiredPackage)))
                throw new Error('Required packages missing. Installing dependencies...')

            /* Function ends here if first time setup has already been completed */
        } catch(e) {
            // TODO: Subscribe to onDidChangePythonInterpreter event and automatically continue operations
            if(!pythonInterpreter) {
                vscode.window.showErrorMessage('[uNGINXed] Python interpreter needs to be selected to perform first-time setup.')
                return
            }
    
            // Create venv. This is the only thing the user-selected python interpreter will be used for.
            const venvCreationResult = await execAsync(`${pythonInterpreter} -m venv ${venvPath}`)
    
            // TODO: Try to ship a python executable with the vsix to avoid depending on the user's system
            //       having python installed
            if(venvCreationResult.err) {
                vscode.window.showErrorMessage(`[uNGINXed] Error creating venv: ${venvCreationResult.err.message}`)
                return
            }
            
            vscode.window.showInformationMessage('[uNGINXed] Installing dependencies...')
            
            // Upon successful creation of venv, install required packages.
            const pipInstallResult = await execAsync(`${venvPythonPath} -m pip install ${REQUIRED_PACKAGES.join(' ')}`)

            if(pipInstallResult.err)
                vscode.window.showErrorMessage('[uNGINXed] Error installing dependencies.')
            else
                vscode.window.showInformationMessage('[uNGINXed] Setup complete!')
        }
    }
    
    await performFirstTimeSetup()
    
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
            if(!pythonInterpreter) {
                vscode.window.showErrorMessage('A Python interpreter must be selected before this extension can be used.')
                return
            }

            // Create directory to write PDF
            const workspaceDir = vscode.workspace.workspaceFolders[0].uri
            const outputUri = vscode.Uri.joinPath(workspaceDir, 'output', 'unginxed')
            const outputDir = outputUri.fsPath
            vscode.workspace.fs.createDirectory(outputUri)

            // Execute command to write PDF
            const unginxedModulePath = vscode.Uri.joinPath(context.extensionUri, 'uNGINXed').fsPath
            const openEditorFilePath = textEditor.document.fileName

            // Currently only supports windows by executing batch script commands.
            // For this call of "exec", edit the PYTHONPATH variable
            const command = `SET PYTHONPATH=%PYTHONPATH%;${unginxedModulePath} && ${venvPythonPath} -m unginxed ${openEditorFilePath} --pdf-output=${outputDir}`
            console.log('Writing PDF. Command:')
            console.log(command)

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
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter && interpreter.length > 0 && checkVersion(await resolveInterpreter(interpreter))) {
            traceVerbose(`Using interpreter from ${serverInfo.module}.interpreter: ${interpreter.join(' ')}`);
            lsClient = await restartServer(venvPythonPath, serverId, serverName, outputChannel, lsClient);
            return;
        }

        const interpreterDetails = await getInterpreterDetails();
        if (interpreterDetails.path) {
            traceVerbose(`Using interpreter from Python extension: ${interpreterDetails.path.join(' ')}`);
            lsClient = await restartServer(venvPythonPath, serverId, serverName, outputChannel, lsClient);
            return;
        }

        traceError(
            'Python interpreter missing:\r\n' +
                '[Option 1] Select python interpreter using the ms-python.python.\r\n' +
                `[Option 2] Set an interpreter using "${serverId}.interpreter" setting.\r\n` +
                'Please use Python 3.7 or greater.',
        );
    };

    context.subscriptions.push(
        onDidChangePythonInterpreter(async () => {
            vscode.window.showErrorMessage('')
            pythonInterpreter = (await getInterpreterDetails()).path?.[0]
            await performFirstTimeSetup()
            await runServer();
        }),
        onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
            if (checkIfConfigurationChanged(e, serverId)) {
                await runServer();
            }
        }),
        registerCommand(`${serverId}.restart`, async () => {
            await runServer();
        }),
    );

    setImmediate(async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter === undefined || interpreter.length === 0) {
            traceLog(`Python extension loading`);
            await initializePython(context.subscriptions);
            traceLog(`Python extension loaded`);
        } else {
            await runServer();
        }
    });
}

export async function deactivate(): Promise<void> {
    if (lsClient) {
        await lsClient.stop();
    }
}
