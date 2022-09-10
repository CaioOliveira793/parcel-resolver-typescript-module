import { join as joinpath } from "node:path";
import { loadPackageJson, PackageJson } from "packageJsonLoader";
import { FileSystem } from "types";
import { moduleHasExtension, relativeModule } from "./utils";


export type TsconfigPaths = Record<string, string[]>;

export interface TypescriptModuleResolverFlags {
	/**
	 * Verifies if a module already has extension before matching with the resolver specified extensions.
	 *
	 * @default false
	 */
	verifyModuleExtension: boolean;
}

export interface TypescriptModuleResolverConfig {
	/**
	 * Absolute path of tsconfig's base url.
	 *
	 * If tsconfig file does not have baseUrl, consider joing the project root
	 * with a empty string
	 *
	 * @example
	 *
	 * ```ts
	 * const absoluteBaseUrl = path.join(projectRoot, baseUrl ?? '')
	 * ```
	 */
	absoluteBaseUrl: string;

	/**
	 * `paths` entry of tsconfig file.
	 */
	paths?: TsconfigPaths;

	/**
	 * Extensions used to search modules
	 *
	 * @default
	 * ['.ts', '.tsx', '.d.ts']
	 */
	extensions?: string[];

	/** Custom flags to modify resolver behaviour */
	flags?: TypescriptModuleResolverFlags;

	/** Resolver file system */
	fileSystem: FileSystem,
}

interface PathAlias {
	prefix: string;
	absolutePaths: string[]
}

const DEFAULT_FLAGS: TypescriptModuleResolverFlags = {
	verifyModuleExtension: false
};

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.d.ts'];

const PATH_MAPPING_EXTENSION_REGEX = /\*$/

// TODO: implement node_modules resolution jumping up directories
// https://www.typescriptlang.org/docs/handbook/module-resolution.html#how-nodejs-resolves-modules
// https://nodejs.org/api/modules.html#modules_loading_from_node_modules_folders

export class TypescriptModuleResolver {
	private readonly fs: FileSystem;
	private readonly absoluteBaseUrl: string;
	private readonly paths: TsconfigPaths;
	private readonly resolvedAbsolutePathsMap: PathAlias[];
	private readonly extensions: string[];
	private readonly flags: TypescriptModuleResolverFlags;

	constructor(config: TypescriptModuleResolverConfig) {
		this.fs = config.fileSystem;
		this.absoluteBaseUrl = config.absoluteBaseUrl;
		this.paths = config.paths ?? {};
		this.extensions = config.extensions ?? DEFAULT_EXTENSIONS;
		this.flags = { ...DEFAULT_FLAGS, ...config.flags };

		this.resolvedAbsolutePathsMap = [];
		for (const pathAlias in this.paths) {
			const reolvedPaths = [];
			for (const pathEntry of this.paths[pathAlias]) {
				reolvedPaths.push(joinpath(
					this.absoluteBaseUrl,
					pathEntry.replace(PATH_MAPPING_EXTENSION_REGEX, '')
				));
			}

			this.resolvedAbsolutePathsMap.push({
				prefix: pathAlias.replace(PATH_MAPPING_EXTENSION_REGEX, ''),
				absolutePaths: reolvedPaths
			});
		}
	}

	public async resolve(module: string, importerAbsolutePath?: string | null): Promise<string | null> {
		if (relativeModule(module)) {
			if (!importerAbsolutePath) return null;

			return this.resolveRelativeModule(module, importerAbsolutePath);
		}

		return this.resolveAbsoluteModule(module);
	}

	private async resolveRelativeModule(relativeModule: string, importerAbsolutePath: string): Promise<string | null> {
		const module = joinpath(importerAbsolutePath, '..', relativeModule);
		return this.resolveLookups(module);
	}

	private async resolveAbsoluteModule(absoluteModule: string): Promise<string | null> {
		for (const { prefix, absolutePaths } of this.resolvedAbsolutePathsMap) {
			if (!absoluteModule.startsWith(prefix)) continue;

			const relativePathFromAlias = absoluteModule.substring(prefix.length);
			for (const resolvedAliasPath of absolutePaths) {
				const module = joinpath(resolvedAliasPath, relativePathFromAlias);
				const filePath = await this.resolveLookups(module);
				if (filePath) return filePath;
			}
		}

		const absoluteModuleFromBaseUrl = joinpath(this.absoluteBaseUrl, absoluteModule);
		const filePath = await this.resolveLookups(absoluteModuleFromBaseUrl);
		if (filePath) return filePath;

		return null;
	}


	private async resolveLookups(absoluteModule: string): Promise<string | null> {
		const filePath = await this.verifyExtensions(absoluteModule);
		if (filePath) return filePath;

		const packageJsonPath = joinpath(absoluteModule, 'package.json');
		const content = await loadPackageJson(packageJsonPath, this.fs);
		if (content) {
			const relativeFilePath = this.getPackageJsonProperties(content);
			if (relativeFilePath) return joinpath(absoluteModule, relativeFilePath);
		}

		const indexFilePath = await this.verifyExtensions(joinpath(absoluteModule, 'index'));
		if (indexFilePath) return indexFilePath;

		return null;
	}

	private async verifyExtensions(module: string): Promise<string | null> {
		if (this.flags.verifyModuleExtension) {
			if (moduleHasExtension(module)) {
				const fileExists = await this.fs.exists(module);
				if (fileExists) return module;
			}
		}

		for (const extension of this.extensions) {
			const filePath = module + extension;
			const fileExists = await this.fs.exists(filePath);
			if (fileExists) return filePath;
		}
		return null;
	}

	private getPackageJsonProperties(packageObj: PackageJson): string | null {
		if (packageObj.types) return packageObj.types;
		if (packageObj.module) return packageObj.module;
		if (packageObj.main) return packageObj.main;
		return null;
	}

}
