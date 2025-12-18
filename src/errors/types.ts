import { AppError } from './base';

export class FileSystemError extends AppError {
	readonly code = 'FILESYSTEM_ERROR';
	readonly path: string;
	readonly operation: 'read' | 'write' | 'delete' | 'move' | 'stat' | 'list';

	constructor(
		message: string,
		path: string,
		operation: FileSystemError['operation'],
		cause?: unknown,
	) {
		super(message, cause);
		this.path = path;
		this.operation = operation;
	}

	static read(path: string, cause?: unknown): FileSystemError {
		return new FileSystemError(`Failed to read file: ${path}`, path, 'read', cause);
	}

	static write(path: string, cause?: unknown): FileSystemError {
		return new FileSystemError(`Failed to write file: ${path}`, path, 'write', cause);
	}

	static delete(path: string, cause?: unknown): FileSystemError {
		return new FileSystemError(`Failed to delete file: ${path}`, path, 'delete', cause);
	}

	static move(path: string, cause?: unknown): FileSystemError {
		return new FileSystemError(`Failed to move file: ${path}`, path, 'move', cause);
	}

	static stat(path: string, cause?: unknown): FileSystemError {
		return new FileSystemError(`Failed to stat file: ${path}`, path, 'stat', cause);
	}

	static list(path: string, cause?: unknown): FileSystemError {
		return new FileSystemError(`Failed to list directory: ${path}`, path, 'list', cause);
	}
}

export class ZipError extends AppError {
	readonly code = 'ZIP_ERROR';
	readonly zipPath: string;

	constructor(message: string, zipPath: string, cause?: unknown) {
		super(message, cause);
		this.zipPath = zipPath;
	}

	static corrupt(zipPath: string, cause?: unknown): ZipError {
		return new ZipError(`Corrupt or invalid zip file: ${zipPath}`, zipPath, cause);
	}

	static tooLarge(zipPath: string, limit: number): ZipError {
		return new ZipError(`Zip file exceeds size limit of ${limit} bytes: ${zipPath}`, zipPath);
	}

	static tooManyEntries(zipPath: string, limit: number): ZipError {
		return new ZipError(`Zip file exceeds entry limit of ${limit}: ${zipPath}`, zipPath);
	}

	static entryTooLarge(zipPath: string, entryName: string, limit: number): ZipError {
		return new ZipError(`Entry ${entryName} exceeds size limit of ${limit} bytes`, zipPath);
	}

	static extraction(zipPath: string, cause?: unknown): ZipError {
		return new ZipError(`Failed to extract zip file: ${zipPath}`, zipPath, cause);
	}
}

export class S3Error extends AppError {
	readonly code = 'S3_ERROR';
	readonly bucket: string;
	readonly key: string | undefined;
	readonly operation: 'put' | 'get' | 'delete' | 'list';

	constructor(
		message: string,
		bucket: string,
		operation: S3Error['operation'],
		key?: string,
		cause?: unknown,
	) {
		super(message, cause);
		this.bucket = bucket;
		this.key = key;
		this.operation = operation;
	}

	static put(bucket: string, key: string, cause?: unknown): S3Error {
		return new S3Error(`Failed to upload to S3: ${bucket}/${key}`, bucket, 'put', key, cause);
	}

	static partialUpload(bucket: string, failedCount: number, totalCount: number): S3Error {
		return new S3Error(
			`Partial upload failure: ${failedCount}/${totalCount} files failed`,
			bucket,
			'put',
		);
	}
}

export class ProcessingError extends AppError {
	readonly code = 'PROCESSING_ERROR';

	static timeout(remaining: number, buffer: number): ProcessingError {
		return new ProcessingError(
			`Processing stopped: ${remaining}ms remaining, buffer is ${buffer}ms`,
		);
	}

	static noFiles(directory: string): ProcessingError {
		return new ProcessingError(`No zip files found in ${directory}`);
	}
}

export type DomainError = FileSystemError | ZipError | S3Error | ProcessingError;
