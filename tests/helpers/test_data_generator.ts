import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import archiver from 'archiver';

export interface GeneratedFile {
	readonly filename: string;
	readonly content: string;
	readonly shouldBeFiltered: boolean;
}

export interface GeneratedZip {
	readonly zipPath: string;
	readonly files: readonly GeneratedFile[];
}

/**
 * Simple seeded PRNG for deterministic test data.
 * Using mulberry32 algorithm.
 */
function createSeededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function generateTransactionId(random: () => number): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let id = 'TXN-';
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(random() * chars.length)];
	}
	return id;
}

function generateXmlContent(
	transactionId: string,
	isTest: boolean,
	random: () => number,
): string {
	const amount = (random() * 10000).toFixed(2);
	const currency = ['GBP', 'USD', 'EUR'][Math.floor(random() * 3)];
	const storeId = Math.floor(random() * 100) + 1;

	return `<?xml version="1.0" encoding="UTF-8"?>
<Transaction>
  <TransactionId>${transactionId}</TransactionId>
  <Amount>${amount}</Amount>
  <Currency>${currency}</Currency>
  <StoreId>${storeId}</StoreId>
  <IsTest>${isTest}</IsTest>
  <Timestamp>${new Date().toISOString()}</Timestamp>
</Transaction>`;
}

export interface GenerateZipOptions {
	readonly outputDir: string;
	readonly zipName: string;
	readonly fileCount: number;
	readonly testFileRatio?: number; // 0-1, proportion of files that should be filtered
	readonly seed?: number;
}

export async function generateTestZip(options: GenerateZipOptions): Promise<GeneratedZip> {
	const { outputDir, zipName, fileCount, testFileRatio = 0, seed = 12345 } = options;
	const random = createSeededRandom(seed);

	await mkdir(outputDir, { recursive: true });

	const zipPath = join(outputDir, zipName);
	const files: GeneratedFile[] = [];

	// Generate file metadata first
	for (let i = 0; i < fileCount; i++) {
		const shouldBeFiltered = random() < testFileRatio;
		const transactionId = generateTransactionId(random);
		const content = generateXmlContent(transactionId, shouldBeFiltered, random);

		files.push({
			filename: `${transactionId}.xml`,
			content,
			shouldBeFiltered,
		});
	}

	// Create the zip file
	await new Promise<void>((resolve, reject) => {
		const output = createWriteStream(zipPath);
		const archive = archiver('zip', { zlib: { level: 5 } });

		output.on('close', resolve);
		archive.on('error', reject);

		archive.pipe(output);

		for (const file of files) {
			archive.append(file.content, { name: file.filename });
		}

		archive.finalize();
	});

	return { zipPath, files };
}

export interface GenerateBatchOptions {
	readonly outputDir: string;
	readonly zipCount: number;
	readonly filesPerZip: number;
	readonly testFileRatio?: number;
	readonly baseSeed?: number;
}

export async function generateTestBatch(options: GenerateBatchOptions): Promise<GeneratedZip[]> {
	const { outputDir, zipCount, filesPerZip, testFileRatio = 0, baseSeed = 12345 } = options;

	const zips: GeneratedZip[] = [];

	for (let i = 0; i < zipCount; i++) {
		const zip = await generateTestZip({
			outputDir,
			zipName: `batch-${String(i).padStart(3, '0')}.zip`,
			fileCount: filesPerZip,
			testFileRatio,
			seed: baseSeed + i, // Different seed per zip for variety
		});
		zips.push(zip);
	}

	return zips;
}

/**
 * Calculate expected outcomes from generated test data.
 */
export function calculateExpectedOutcomes(zips: readonly GeneratedZip[]): {
	totalFiles: number;
	expectedUploaded: number;
	expectedFiltered: number;
	transactionIds: Set<string>;
} {
	let totalFiles = 0;
	let expectedFiltered = 0;
	const transactionIds = new Set<string>();

	for (const zip of zips) {
		for (const file of zip.files) {
			totalFiles++;
			if (file.shouldBeFiltered) {
				expectedFiltered++;
			} else {
				// Extract transaction ID from filename (e.g., "TXN-ABC12345.xml" -> "TXN-ABC12345")
				const txnId = file.filename.replace('.xml', '');
				transactionIds.add(txnId);
			}
		}
	}

	return {
		totalFiles,
		expectedUploaded: totalFiles - expectedFiltered,
		expectedFiltered,
		transactionIds,
	};
}
