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
]


let lsClient: LanguageClient | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Pre-requisite: Python interpreter must be selected
    let pythonInterpreter = (await getInterpreterDetails()).path?.[0]
    let venvScriptsPath = ''
    let venvActivateCommand = ''
    
    // TODO: Subscribe to onDidChangePythonInterpreter event and automatically continue operations
    if(!pythonInterpreter) {
        vscode.window.showErrorMessage('A Python interpreter must be selected before this extension can be used.')
    } else {
        // Check pre-requisite packages
        const pipFreezeResult = await execAsync(`${pythonInterpreter} -m pip freeze`)
        const lines = pipFreezeResult.stdout.split('\n')
        const packages: string[] = lines.map((line) => line.split('==')[0])

        // Install packages if requirements not installed
        if(REQUIRED_PACKAGES.some((requiredPackage) => !packages.includes(requiredPackage))) {
            vscode.window.showInformationMessage('Installing required python packages...')
            const venvUri = vscode.Uri.joinPath(context.globalStorageUri, 'venv')

            // Create venv
            const venvPath = venvUri.fsPath

            let venvCreationResult = await execAsync(`${pythonInterpreter} -m venv ${venvPath}`)

            if(venvCreationResult.err) {
                vscode.window.showErrorMessage(`Error creating venv: ${venvCreationResult.err.message}`)
            }

            // Install packages
            // TODO: Make this platform-independent, do not rely on hard-coded '.bat' extension
            venvScriptsPath = vscode.Uri.joinPath(venvUri, 'Scripts').fsPath
            venvActivateCommand = `${venvScriptsPath}\\activate.bat`
            const pipInstallResult = await execAsync(`${venvActivateCommand} && python -m pip install ${REQUIRED_PACKAGES.join(' ')}`)
            console.log(venvScriptsPath)
            console.log(pipInstallResult.stdout)
            console.log(pipInstallResult.stderr)
        }
    }

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
            const command = `${venvActivateCommand} && set PYTHONPATH=%PYTHONPATH%;${unginxedModulePath} && python -m unginxed ${openEditorFilePath} --pdf-output=${outputDir}`
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

    const getRunServerCommand = () => `${venvActivateCommand} && python`

    const runServer = async () => {
        const interpreter = getInterpreterFromSetting(serverId);
        if (interpreter && interpreter.length > 0 && checkVersion(await resolveInterpreter(interpreter))) {
            traceVerbose(`Using interpreter from ${serverInfo.module}.interpreter: ${interpreter.join(' ')}`);
            lsClient = await restartServer(getRunServerCommand(), serverId, serverName, outputChannel, lsClient);
            return;
        }

        const interpreterDetails = await getInterpreterDetails();
        if (interpreterDetails.path) {
            traceVerbose(`Using interpreter from Python extension: ${interpreterDetails.path.join(' ')}`);
            lsClient = await restartServer(getRunServerCommand(), serverId, serverName, outputChannel, lsClient);
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
