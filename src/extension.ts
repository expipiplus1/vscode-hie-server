'use strict';
import * as os from 'os';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  commands,
  ExtensionContext,
  OutputChannel,
  Uri,
  workspace,
} from 'coc.nvim';
import {
  WorkspaceFolder,
} from 'vscode-languageserver-protocol';
import {
  ExecutableOptions,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  TransportKind,
} from 'coc.nvim';
import { CommandNames } from './commands/constants';
import { HLintApply } from './commands/HLintApply';
import { executableExists } from './utils';

// The current map of documents & folders to language servers.
// It may be null to indicate that we are in the process of launching a server,
// in which case don't try to launch another one for that uri
const clients: Map<string, LanguageClient | null> = new Map();

// This is the entrypoint to our extension
export async function activate(context: ExtensionContext) {
  // (Possibly) launch the language server every time a document is opened, so
  // it works across multiple workspace folders. Eventually, haskell-lsp should
  // just support
  // https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/#workspace_workspaceFolders
  // and then we can just launch one server
  workspace.onDidOpenTextDocument(async (document: TextDocument) => await activeServer(context, document));
  workspace.textDocuments.forEach(async (document: TextDocument) => await activeServer(context, document));

  // Stop the server from any workspace folders that are removed.
  workspace.onDidChangeWorkspaceFolders((event) => {
    for (const folder of event.removed) {
      const client = clients.get(folder.uri.toString());
      if (client) {
        clients.delete(folder.uri.toString());
        client.stop();
      }
    }
  });

  // Register editor commands for HIE, but only register the commands once at activation.
  const restartCmd = commands.registerCommand(CommandNames.RestartServerCommandName, async () => {
    for (const langClient of clients.values()) {
      await langClient?.stop();
      langClient?.start();
    }
  });
  context.subscriptions.push(restartCmd);

  // Add the HLint commands
  HLintApply.registerCommands(clients, context);
}

function findManualExecutable(uri: Uri, folder?: WorkspaceFolder): string | null {
  let exePath = workspace.getConfiguration('haskell', uri.toString()).serverExecutablePath;
  if (exePath === '') {
    return null;
  }

  // Substitute path variables with their corresponding locations.
  exePath = exePath.replace('${HOME}', os.homedir).replace('${home}', os.homedir).replace(/^~/, os.homedir);
  if (folder) {
    exePath = exePath.replace('${workspaceFolder}', Uri.parse(folder.uri).path).replace('${workspaceRoot}', Uri.parse(folder.uri).path);
  }

  if (!executableExists(exePath)) {
    throw new Error(`serverExecutablePath is set to ${exePath} but it doesn't exist and is not on the PATH`);
  }
  return exePath;
}

/** Searches the PATH for whatever is set in serverVariant */
function findLocalServer(context: ExtensionContext, uri: Uri, folder?: WorkspaceFolder): string | null {
  const serverVariant = workspace.getConfiguration('haskell', uri.toString()).languageServerVariant;

  // Set the executable, based on the settings.
  let exes: string[] = []; // should get set below
  switch (serverVariant) {
    case 'haskell-ide-engine':
      exes = ['hie-wrapper', 'hie'];
      break;
    case 'haskell-language-server':
      exes = ['haskell-language-server-wrapper', 'haskell-language-server'];
      break;
    case 'ghcide':
      exes = ['ghcide'];
      break;
  }

  for (const exe of exes) {
    if (executableExists(exe)) {
      return exe;
    }
  }

  return null;
}

async function activeServer(context: ExtensionContext, document: TextDocument) {
  // We are only interested in Haskell files.
  if (
    (document.languageId !== 'haskell' &&
      document.languageId !== 'cabal' &&
      document.languageId !== 'literate Haskell') ||
    (Uri.parse(document.uri).scheme !== 'file' && Uri.parse(document.uri).scheme !== 'untitled')
  ) {
    return;
  }

  const uri = document.uri;
  const folder = workspace.getWorkspaceFolder(uri);

  activateServerForFolder(context, Uri.parse(uri), folder ? folder : undefined);
}

async function activateServerForFolder(context: ExtensionContext, uri: Uri, folder?: WorkspaceFolder) {
  const clientsKey = folder ? folder.uri.toString() : uri.toString();

  // If the client already has an LSP server for this uri/folder, then don't start a new one.
  if (clients.has(clientsKey)) {
    return;
  }
  // Set the key to null to prevent multiple servers being launched at once
  clients.set(clientsKey, null);

  const logLevel = workspace.getConfiguration('haskell', uri.toString()).trace.server;
  const logFile = workspace.getConfiguration('haskell', uri.toString()).logFile;

  let serverExecutable;
  try {
    // Try and find local installations first
    serverExecutable = findManualExecutable(uri, folder) ?? findLocalServer(context, uri, folder);
    if (serverExecutable === null) {
        showNotInstalledErrorMessage(uri);
        return;
    }
  } catch (e) {
    if (e instanceof Error) {
      workspace.showMessage(e.message, 'error');
    }
    return;
  }

  let args: string[] = ['--lsp'];

  const serverVariant = workspace.getConfiguration('haskell', uri.toString()).languageServerVariant;
  // ghcide does not accept -d and -l params
  if (serverVariant !== 'ghcide') {
    if (logLevel === 'messages') {
      args = args.concat(['-d']);
    }

    if (logFile !== '') {
      args = args.concat(['-l', logFile]);
    }
  }

  // If we're operating on a standalone file (i.e. not in a folder) then we need
  // to launch the server in a reasonable current directory. Otherwise the cradle
  // guessing logic in hie-bios will be wrong!
  const exeOptions: ExecutableOptions = {
    cwd: folder ? undefined : path.dirname(uri.fsPath),
  };

  // For our intents and purposes, the server should be launched the same way in
  // both debug and run mode.
  const serverOptions: ServerOptions = {
    run: { command: serverExecutable, transport: TransportKind.stdio, args, options: exeOptions },
    debug: { command: serverExecutable, transport: TransportKind.stdio, args, options: exeOptions },
  };

  // Set a unique name per workspace folder (useful for multi-root workspaces).
  const langName = 'Haskell' + (folder ? ` (${folder.name})` : '');
  const outputChannel: OutputChannel = workspace.createOutputChannel(langName);
  outputChannel.appendLine('[client] run command: "' + serverExecutable + ' ' + args.join(' ') + '"');
  outputChannel.appendLine('[client] debug command: "' + serverExecutable + ' ' + args.join(' ') + '"');

  outputChannel.appendLine(`[client] server cwd: ${exeOptions.cwd}`);

  const pat = folder ? `${Uri.parse(folder.uri).fsPath}/**/*` : '**/*';
  const clientOptions: LanguageClientOptions = {
    // Use the document selector to only notify the LSP on files inside the folder
    // path for the specific workspace.
    documentSelector: [
      { scheme: 'file', language: 'haskell', pattern: pat },
      { scheme: 'file', language: 'literate haskell', pattern: pat },
    ],
    synchronize: {
      // Synchronize the setting section 'haskell' to the server.
      configurationSection: 'haskell',
    },
    diagnosticCollectionName: langName,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    outputChannel,
    outputChannelName: langName,
    middleware: {},
    // Launch the server in the directory of the workspace folder.
    workspaceFolder: folder,
  };

  // Create the LSP client.
  const langClient = new LanguageClient(langName, langName, serverOptions, clientOptions);

  // Register ClientCapabilities for stuff like window/progress
  langClient.registerProposedFeatures();

  // Finally start the client and add it to the list of clients.
  langClient.start();
  clients.set(clientsKey, langClient);
}

/*
 * Deactivate each of the LSP servers.
 */
export async function deactivate() {
  const promises: Array<Thenable<void>> = [];
  for (const client of clients.values()) {
    if (client) {
      promises.push(client.stop());
    }
  }
  await Promise.all(promises);
}

function showNotInstalledErrorMessage(uri: Uri) {
  const variant = workspace.getConfiguration('haskell', uri.toString()).languageServerVariant;
  let projectUrl = '';
  switch (variant) {
    case 'haskell-ide-engine':
      projectUrl = '/haskell/haskell-ide-engine';
      break;
    case 'haskell-language-server':
      projectUrl = '/haskell/haskell-language-server';
      break;
    case 'ghcide':
      projectUrl = '/digital-asset/ghcide';
      break;
  }
  const notInstalledMsg: string =
    variant + ' executable missing, please make sure it is installed, see https://github.com' + projectUrl + '.';
  workspace.showMessage(notInstalledMsg, 'error');
}
