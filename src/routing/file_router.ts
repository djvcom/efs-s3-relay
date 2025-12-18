import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { FileSystemError } from '../errors';
import { type AsyncResult, tryAsync } from '../result';
import type { FilePath } from '../types/branded';

export function tryMoveFile(
	sourcePath: FilePath,
	destinationDir: FilePath,
): AsyncResult<void, FileSystemError> {
	return tryAsync(
		async () => {
			await mkdir(destinationDir, { recursive: true });
			const filename = basename(sourcePath);
			const destinationPath = join(destinationDir, filename);
			await rename(sourcePath, destinationPath);
		},
		cause => FileSystemError.move(sourcePath, cause),
	);
}

export function tryDeleteFile(filePath: FilePath): AsyncResult<void, FileSystemError> {
	return tryAsync(
		() => unlink(filePath),
		cause => FileSystemError.delete(filePath, cause),
	);
}

export function tryGetFileAgeMs(filePath: FilePath): AsyncResult<number, FileSystemError> {
	return tryAsync(
		async () => {
			const stats = await stat(filePath);
			return Date.now() - stats.mtimeMs;
		},
		cause => FileSystemError.stat(filePath, cause),
	);
}

export function tryRouteFile(
	sourcePath: FilePath,
	success: boolean,
	archiveDir: FilePath,
	failedDir: FilePath,
	deleteOnSuccess: boolean,
): AsyncResult<void, FileSystemError> {
	if (success) {
		if (deleteOnSuccess) {
			return tryDeleteFile(sourcePath);
		}
		return tryMoveFile(sourcePath, archiveDir);
	}
	return tryMoveFile(sourcePath, failedDir);
}
