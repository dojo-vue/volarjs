import type { ExportsInfoForLabs } from '@volar/vscode';
import type { GetProjectsRequest } from '@volar/language-server';
import * as path from 'path';
import * as vscode from 'vscode';
import * as lsp from 'vscode-languageclient';
import { useVolarExtensions, getIconPath } from '../common/shared';

interface LanguageClientItem {
	extension: vscode.Extension<ExportsInfoForLabs>;
	client: lsp.BaseLanguageClient;
}

interface LanguageClientFieldItem extends LanguageClientItem {
	field: 'start' | 'stop' | 'restart' | 'enableCodegenStack' | 'disableCodegenStack' | 'initializationOptions' | 'initializeResult' | 'projects';
}

interface LanguageClientProjectItem extends LanguageClientItem {
	project: NonNullable<GetProjectsRequest.ResponseType>[number];
}

interface LanguageClientProjectFileItem extends LanguageClientProjectItem {
	file: string;
}

export function activate(context: vscode.ExtensionContext) {

	const extensions: vscode.Extension<ExportsInfoForLabs>[] = [];
	const onDidChangeTreeData = new vscode.EventEmitter<void>();
	const tree: vscode.TreeDataProvider<LanguageClientItem | LanguageClientFieldItem | LanguageClientProjectItem | LanguageClientProjectFileItem> = {
		onDidChangeTreeData: onDidChangeTreeData.event,
		async getChildren(element) {
			// root
			if (!element) {
				return extensions.map(extension => extension.exports.volarLabs.languageClients.map(client => ({ extension, client }))).flat();
			}
			// child
			if ('file' in element) {
				return [];
			}
			else if ('project' in element) {
				const fileNames = await element.client.sendRequest(element.extension.exports.volarLabs.languageServerProtocol.GetProjectFilesRequest.type, { rootUri: element.project.rootUri, tsconfig: element.project.tsconfig }) ?? [];
				return fileNames.map(fileName => ({ ...element, file: fileName }));
			}
			else if ('field' in element) {
				if (element.field === 'projects') {
					const currentUri = vscode.window.activeTextEditor ? { uri: vscode.window.activeTextEditor.document.uri.toString() } : undefined;
					const projects: GetProjectsRequest.ResponseType = await element.client.sendRequest(element.extension.exports.volarLabs.languageServerProtocol.GetProjectsRequest.type, currentUri) ?? [];
					return projects.map<LanguageClientProjectItem>(project => ({ ...element, project }));
				}
				return [];
			}
			else {
				const stats: LanguageClientFieldItem[] = [];
				if (element.client.state === lsp.State.Running) {
					stats.push({ ...element, field: 'stop' });
					stats.push({ ...element, field: 'restart' });
					if (element.extension.exports.volarLabs.codegenStackSupport) {
						element.client.clientOptions.initializationOptions ??= {};
						if (element.client.clientOptions.initializationOptions.codegenStack) {
							stats.push({ ...element, field: 'disableCodegenStack' });
						}
						else {
							stats.push({ ...element, field: 'enableCodegenStack' });
						}
					}
					stats.push({ ...element, field: 'initializationOptions' });
					stats.push({ ...element, field: 'initializeResult' });
					stats.push({ ...element, field: 'projects' });
				}
				else if (element.client.state === lsp.State.Starting) {
					stats.push({ ...element, field: 'stop' });
				}
				else {
					stats.push({ ...element, field: 'start' });
				}
				return stats;
			}
		},
		getTreeItem(element) {
			if ('file' in element) {
				return {
					iconPath: new vscode.ThemeIcon('file'),
					label: path.relative(element.project.rootUri, vscode.Uri.file(element.file).toString()),
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					command: {
						command: 'vscode.open',
						title: '',
						arguments: [vscode.Uri.file(element.file)],
					},
				};
			}
			else if ('project' in element) {
				let label = '[inferred]';
				if (element.project.tsconfig) {
					label = path.relative(element.project.rootUri, vscode.Uri.file(element.project.tsconfig).toString());
				}
				if (element.project.isSelected) {
					label += ' 👈';
				}
				return {
					iconPath: element.project.created ? new vscode.ThemeIcon('debug-breakpoint-disabled') : new vscode.ThemeIcon('debug-breakpoint-unverified'),
					label,
					collapsibleState: element.project.created ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
				};
			}
			else if ('field' in element) {
				if (element.field === 'restart') {
					return {
						iconPath: new vscode.ThemeIcon('extensions-refresh'),
						label: 'Restart',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: '_volar.action.restartServer',
							title: '',
							arguments: [element.client],
						},
					};
				}
				else if (element.field === 'start') {
					return {
						iconPath: new vscode.ThemeIcon('debug-start'),
						label: 'Start',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: '_volar.action.startServer',
							title: '',
							arguments: [element.client],
						},
					};
				}
				else if (element.field === 'stop') {
					return {
						iconPath: new vscode.ThemeIcon('debug-stop'),
						label: element.client.state === lsp.State.Starting ? 'Starting...' : 'Stop',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: '_volar.action.stopServer',
							title: '',
							arguments: [element.client],
						},
					};
				}
				else if (element.field === 'enableCodegenStack') {
					return {
						iconPath: new vscode.ThemeIcon('primitive-dot'),
						label: 'Enable Codegen Stack',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: '_volar.action.enableCodegenStack',
							title: '',
							arguments: [element.client],
						},
					};
				}
				else if (element.field === 'disableCodegenStack') {
					return {
						iconPath: new vscode.ThemeIcon('debug-breakpoint'),
						label: 'Disable Codegen Stack',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: '_volar.action.disableCodegenStack',
							title: '',
							arguments: [element.client],
						},
					};
				}
				else if (element.field === 'initializationOptions') {
					return {
						iconPath: new vscode.ThemeIcon('file'),
						label: 'Initialization Options',
						resourceUri: vscode.Uri.parse('volar:/initializationOptions.json'),
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: 'volar.action.serverStat.initializationOptions',
							title: '',
							arguments: [element.client],
						},
					};
				}
				else if (element.field === 'initializeResult') {
					return {
						iconPath: new vscode.ThemeIcon('file'),
						label: 'Initialize Result',
						resourceUri: vscode.Uri.parse('volar:/initializeResult.json'),
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: 'volar.action.serverStat.initializeResult',
							title: '',
							arguments: [element.client],
						},
					};
				}
				else if (element.field === 'projects') {
					return {
						label: `Projects`,
						collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
					};
				}
			}
			return {
				iconPath: getIconPath(element.extension),
				label: element.client.name,
				collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
			};
		},
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('_volar.action.startServer', async (client: lsp.BaseLanguageClient) => {
			await client.start();
		}),
		vscode.commands.registerCommand('_volar.action.stopServer', async (client: lsp.BaseLanguageClient) => {
			await client.stop();
		}),
		vscode.commands.registerCommand('_volar.action.restartServer', async (client: lsp.BaseLanguageClient) => {
			await client.stop();
			await client.start();
		}),
		vscode.commands.registerCommand('_volar.action.enableCodegenStack', async (client: lsp.BaseLanguageClient) => {
			client.clientOptions.initializationOptions.codegenStack = true;
			await client.stop();
			await client.start();
		}),
		vscode.commands.registerCommand('_volar.action.disableCodegenStack', async (client: lsp.BaseLanguageClient) => {
			client.clientOptions.initializationOptions.codegenStack = false;
			await client.stop();
			await client.start();
		}),
		vscode.commands.registerCommand('volar.action.serverStat.initializationOptions', async (client: lsp.BaseLanguageClient) => {
			const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(client.clientOptions.initializationOptions, undefined, '\t'), language: 'json' });
			vscode.window.showTextDocument(doc);
		}),
		vscode.commands.registerCommand('volar.action.serverStat.initializeResult', async (client: lsp.BaseLanguageClient) => {
			const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(client.initializeResult, undefined, '\t'), language: 'json' });
			vscode.window.showTextDocument(doc);
		}),
		vscode.window.createTreeView('volar-servers', {
			showCollapseAll: false,
			treeDataProvider: tree,
		}),
	);

	useVolarExtensions(context, extension => {
		for (const client of extension.exports.volarLabs.languageClients) {
			context.subscriptions.push(
				client.onDidChangeState(() => onDidChangeTreeData.fire())
			);
		}
		extensions.push(extension);
		onDidChangeTreeData.fire();
	});
}
