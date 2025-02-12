import * as path from 'typesafe-path/posix';
import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { createProject, Project } from './project';
import { getInferredCompilerOptions } from './utils/inferredCompilerOptions';
import { createUriMap } from './utils/uriMap';
import { isFileInDir } from './utils/isFileInDir';
import { WorkspacesContext } from './workspaces';

import type * as _ from 'vscode-languageserver-textdocument';
import { FileType } from '@volar/language-service';

export const rootTsConfigNames = ['tsconfig.json', 'jsconfig.json'];

export interface WorkspaceContext extends WorkspacesContext {
	workspace: {
		rootUri: URI;
	};
}

export async function createWorkspace(context: WorkspaceContext) {

	let inferredProject: Project | undefined;
	let disposeTsConfigWatch: vscode.Disposable | undefined;

	const { fileNameToUri, uriToFileName, fs } = context.server.runtimeEnv;
	const projects = createUriMap<Project>(fileNameToUri);
	const rootTsConfigs = new Set<path.PosixPath>();
	const searchedDirs = new Set<path.PosixPath>();

	context.server.onDidChangeWatchedFiles(({ changes }) => {
		for (const change of changes) {
			if (rootTsConfigNames.includes(change.uri.substring(change.uri.lastIndexOf('/') + 1))) {
				if (change.type === vscode.FileChangeType.Created) {
					if (isFileInDir(uriToFileName(change.uri) as path.PosixPath, uriToFileName(context.workspace.rootUri.toString()) as path.PosixPath)) {
						rootTsConfigs.add(uriToFileName(change.uri) as path.PosixPath);
					}
				}
				else if ((change.type === vscode.FileChangeType.Changed || change.type === vscode.FileChangeType.Deleted) && projects.uriHas(change.uri)) {
					if (change.type === vscode.FileChangeType.Deleted) {
						rootTsConfigs.delete(uriToFileName(change.uri) as path.PosixPath);
					}
					const project = projects.uriGet(change.uri);
					projects.uriDelete(change.uri);
					project?.then(project => project.dispose());
				}
			}
		}
	});

	return {
		projects,
		getProjectAndTsConfig,
		getInferredProject,
		getInferredProjectDontCreate: () => inferredProject,
		reload: clearProjects,
		dispose() {
			clearProjects();
			disposeTsConfigWatch?.dispose();
		},
	};

	function clearProjects() {
		const _projects = [
			inferredProject,
			...projects.values(),
		];
		_projects.forEach(async project => {
			(await project)?.dispose();
		});
		inferredProject = undefined;
		projects.clear();
	}

	async function getProjectAndTsConfig(uri: string) {
		const tsconfig = await findMatchConfigs(URI.parse(uri));
		if (tsconfig) {
			const project = await getProjectByCreate(tsconfig);
			return {
				tsconfig: tsconfig,
				project,
			};
		}
	}
	function getInferredProject() {
		if (!inferredProject) {
			inferredProject = (async () => {
				const inferOptions = await getInferredCompilerOptions(context.server.configurationHost);
				return createProject({
					...context,
					project: {
						rootUri: context.workspace.rootUri,
						tsConfig: inferOptions,
					},
				});
			})();
		}
		return inferredProject;
	}
	async function findMatchConfigs(uri: URI) {

		const filePath = uriToFileName(uri.toString()) as path.PosixPath;
		let dir = path.dirname(filePath);

		while (true) {
			if (searchedDirs.has(dir)) {
				break;
			}
			searchedDirs.add(dir);
			for (const tsConfigName of rootTsConfigNames) {
				const tsconfigPath = path.join(dir, tsConfigName as path.PosixPath);
				if ((await fs.stat?.(fileNameToUri(tsconfigPath)))?.type === FileType.File) {
					rootTsConfigs.add(tsconfigPath);
				}
			}
			dir = path.dirname(dir);
		}

		await prepareClosestootParsedCommandLine();

		return await findDirectIncludeTsconfig() ?? await findIndirectReferenceTsconfig();

		async function prepareClosestootParsedCommandLine() {

			let matches: path.PosixPath[] = [];

			for (const rootTsConfig of rootTsConfigs) {
				if (isFileInDir(uriToFileName(uri.toString()) as path.PosixPath, path.dirname(rootTsConfig))) {
					matches.push(rootTsConfig);
				}
			}

			matches = matches.sort((a, b) => sortTsConfigs(uriToFileName(uri.toString()) as path.PosixPath, a, b));

			if (matches.length) {
				await getParsedCommandLine(matches[0]);
			}
		}
		function findIndirectReferenceTsconfig() {
			return findTsconfig(async tsconfig => {
				const project = await projects.pathGet(tsconfig);
				return project?.askedFiles.uriHas(uri.toString()) ?? false;
			});
		}
		function findDirectIncludeTsconfig() {
			return findTsconfig(async tsconfig => {
				const map = createUriMap<boolean>(fileNameToUri);
				const parsedCommandLine = await getParsedCommandLine(tsconfig);
				for (const fileName of parsedCommandLine?.fileNames ?? []) {
					map.pathSet(fileName, true);
				}
				return map.uriHas(uri.toString());
			});
		}
		async function findTsconfig(match: (tsconfig: string) => Promise<boolean> | boolean) {

			const checked = new Set<string>();

			for (const rootTsConfig of [...rootTsConfigs].sort((a, b) => sortTsConfigs(uriToFileName(uri.toString()) as path.PosixPath, a, b))) {
				const project = await projects.pathGet(rootTsConfig);
				if (project) {

					let chains = await getReferencesChains(project.getParsedCommandLine(), rootTsConfig, []);

					if (context.workspaces.initOptions.reverseConfigFilePriority) {
						chains = chains.reverse();
					}

					for (const chain of chains) {
						for (let i = chain.length - 1; i >= 0; i--) {
							const tsconfig = chain[i];

							if (checked.has(tsconfig))
								continue;
							checked.add(tsconfig);


							if (await match(tsconfig)) {
								return tsconfig;
							}
						}
					}
				}
			}
		}
		async function getReferencesChains(parsedCommandLine: ts.ParsedCommandLine, tsConfig: string, before: string[]) {

			if (parsedCommandLine.projectReferences?.length) {

				const newChains: string[][] = [];

				for (const projectReference of parsedCommandLine.projectReferences) {

					let tsConfigPath = projectReference.path.replace(/\\/g, '/') as path.PosixPath;

					// fix https://github.com/johnsoncodehk/volar/issues/712
					if ((await fs.stat?.(fileNameToUri(tsConfigPath)))?.type === FileType.File) {
						const newTsConfigPath = path.join(tsConfigPath, 'tsconfig.json' as path.PosixPath);
						const newJsConfigPath = path.join(tsConfigPath, 'jsconfig.json' as path.PosixPath);
						if ((await fs.stat?.(fileNameToUri(newTsConfigPath)))?.type === FileType.File) {
							tsConfigPath = newTsConfigPath;
						}
						else if ((await fs.stat?.(fileNameToUri(newJsConfigPath)))?.type === FileType.File) {
							tsConfigPath = newJsConfigPath;
						}
					}

					const beforeIndex = before.indexOf(tsConfigPath); // cycle
					if (beforeIndex >= 0) {
						newChains.push(before.slice(0, Math.max(beforeIndex, 1)));
					}
					else {
						const referenceParsedCommandLine = await getParsedCommandLine(tsConfigPath);
						if (referenceParsedCommandLine) {
							for (const chain of await getReferencesChains(referenceParsedCommandLine, tsConfigPath, [...before, tsConfig])) {
								newChains.push(chain);
							}
						}
					}
				}

				return newChains;
			}
			else {
				return [[...before, tsConfig]];
			}
		}
		async function getParsedCommandLine(tsConfig: string) {
			const project = await getProjectByCreate(tsConfig);
			return project?.getParsedCommandLine();
		}
	}
	function getProjectByCreate(_tsConfig: string) {
		const tsConfig = _tsConfig.replace(/\\/g, '/') as path.PosixPath;
		let project = projects.pathGet(tsConfig);
		if (!project) {
			project = createProject({
				...context,
				project: {
					rootUri: URI.parse(fileNameToUri(path.dirname(tsConfig))),
					tsConfig,
				},
			});
			projects.pathSet(tsConfig, project);
		}
		return project;
	}
}

export function sortTsConfigs(file: path.PosixPath, a: path.PosixPath, b: path.PosixPath) {

	const inA = isFileInDir(file, path.dirname(a));
	const inB = isFileInDir(file, path.dirname(b));

	if (inA !== inB) {
		const aWeight = inA ? 1 : 0;
		const bWeight = inB ? 1 : 0;
		return bWeight - aWeight;
	}

	const aLength = a.split('/').length;
	const bLength = b.split('/').length;

	if (aLength === bLength) {
		const aWeight = path.basename(a) === 'tsconfig.json' ? 1 : 0;
		const bWeight = path.basename(b) === 'tsconfig.json' ? 1 : 0;
		return bWeight - aWeight;
	}

	return bLength - aLength;
}
