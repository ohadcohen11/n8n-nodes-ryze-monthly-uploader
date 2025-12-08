import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ICredentialDataDecryptedObject,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import * as mysql from 'mysql2/promise';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
import * as AWS from 'aws-sdk';

interface BrandGroupResult {
	brand_group_id: number | string;
	brand_group_name: string;
}

interface UploadResult {
	type: string;
	io_id: string;
	script_id: string;
	brand_group_id: number | string;
	brand_group_name: string;
	path?: string;
	would_upload_to?: string;
	s3_url?: string;
	console_url?: string;
	rows_input: number;
	rows_after_dedup: number;
	duplicates_removed: number;
	size_kb: number;
	upload_duration_ms?: number;
	upload_success: boolean;
	dry_run?: boolean;
}

export class RyzeMonthlyUploader implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ryze Monthly Uploader',
		name: 'ryzeMonthlyUploader',
		icon: {
			light: 'file:ryzeMonthlyUploader.svg',
			dark: 'file:ryzeMonthlyUploader.dark.svg',
		},
		group: ['transform'],
		version: 1,
		description: 'Upload monthly data to AWS S3 for discrepancy analysis',
		defaults: {
			name: 'Ryze Monthly Uploader',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'awsS3Api',
				required: true,
				displayOptions: {
					show: {},
				},
			},
			{
				name: 'mySqlApi',
				required: true,
				displayOptions: {
					show: {},
				},
			},
		],
		properties: [
			// Upload Type (Required)
			{
				displayName: 'Upload Type',
				name: 'uploadType',
				type: 'options',
				options: [
					{
						name: 'Translated',
						value: 'Translated',
						description: 'Data from fetcher/translator (before processors)',
					},
					{
						name: 'Processed',
						value: 'Processed',
						description: 'Data after processor rules applied',
					},
				],
				default: 'Translated',
				required: true,
				description: 'Type of data being uploaded',
			},
			// Script ID (Required)
			{
				displayName: 'Script ID',
				name: 'scriptId',
				type: 'string',
				default: '',
				required: true,
				placeholder: '3000',
				description: 'Your scraper script ID',
			},
			// IO ID (Required only for Translated)
			{
				displayName: 'IO ID',
				name: 'ioId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'eab7e510-eb50-11e9-b544-fb4e13fb7f1d',
				description: 'Brand identifier - required for Translated, auto-detected for Processed',
				displayOptions: {
					show: {
						uploadType: ['Translated'],
					},
				},
			},
			// Year/Month Override (Optional)
			{
				displayName: 'Year/Month Override',
				name: 'yearMonthOverride',
				type: 'string',
				default: '',
				placeholder: 'Leave empty for auto (previous month)',
				description: 'Override automatic date calculation for manual reruns (format: YYYY/MM, e.g., 2025/11)',
			},
			// Options Collection
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'S3 Bucket Name',
						name: 's3BucketName',
						type: 'string',
						default: 'ryze-data-brand-performance',
						description: 'AWS S3 bucket for uploads',
					},
					{
						displayName: 'BO MySQL Database',
						name: 'boDatabase',
						type: 'string',
						default: 'bo',
						description: 'Database name for brand_group lookup',
					},
					{
						displayName: 'Dry Run Mode',
						name: 'dryRun',
						type: 'boolean',
						default: false,
						description: 'Whether to run in test mode - generates CSV and checks brand_group but doesn\'t upload to S3',
					},
					{
						displayName: 'Verbose Logging',
						name: 'verboseLogging',
						type: 'boolean',
						default: false,
						description: 'Whether to include detailed debug information in output',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const startTime = Date.now();

		// Get parameters
		const uploadType = this.getNodeParameter('uploadType', 0) as string;
		const scriptId = this.getNodeParameter('scriptId', 0) as string;
		const yearMonthOverride = this.getNodeParameter('yearMonthOverride', 0, '') as string;
		const options = this.getNodeParameter('options', 0, {}) as {
			s3BucketName?: string;
			boDatabase?: string;
			dryRun?: boolean;
			verboseLogging?: boolean;
		};

		const s3BucketName = options.s3BucketName || 'ryze-data-brand-performance';
		const boDatabase = options.boDatabase || 'bo';
		const dryRun = options.dryRun || false;

		// Get credentials
		const awsCredentials = (await this.getCredentials('awsS3Api')) as ICredentialDataDecryptedObject;
		const mysqlCredentials = (await this.getCredentials('mySqlApi')) as ICredentialDataDecryptedObject;

		// Initialize AWS S3
		const s3 = new AWS.S3({
			accessKeyId: awsCredentials.accessKeyId as string,
			secretAccessKey: awsCredentials.secretAccessKey as string,
			region: awsCredentials.region as string,
		});

		// Determine year/month
		let year: string;
		let month: string;
		if (yearMonthOverride) {
			[year, month] = yearMonthOverride.split('/');
		} else {
			const now = new Date();
			const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			year = previousMonth.getFullYear().toString();
			month = (previousMonth.getMonth() + 1).toString().padStart(2, '0');
		}

		const yearMonth = `${year}/${month}`;

		// Get IO IDs
		let ioIds: string[] = [];
		if (uploadType === 'Translated') {
			const ioId = this.getNodeParameter('ioId', 0) as string;
			ioIds = [ioId];
		} else {
			// Processed: auto-detect from data
			const uniqueIoIds = new Set<string>();
			for (const item of items) {
				if (item.json.io_id) {
					uniqueIoIds.add(item.json.io_id as string);
				}
			}
			ioIds = Array.from(uniqueIoIds);
		}

		if (ioIds.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'No IO IDs found. For Translated, provide IO ID parameter. For Processed, ensure data contains io_id field.',
			);
		}

		// Query brand groups from MySQL
		const mysqlQueryStart = Date.now();
		const connection = await mysql.createConnection({
			host: mysqlCredentials.host as string,
			port: mysqlCredentials.port as number,
			database: boDatabase,
			user: mysqlCredentials.user as string,
			password: mysqlCredentials.password as string,
		});

		const brandGroups = new Map<string, BrandGroupResult>();
		const brandGroupErrors: Record<string, string> = {};

		for (const ioId of ioIds) {
			try {
				// Trim whitespace from IO ID
				const cleanIoId = ioId.trim();

				const query = `SELECT
					bg.id as brand_group_id,
					bg.name as brand_group_name
				FROM ${boDatabase}.out_brands AS b
				LEFT JOIN ${boDatabase}.brands_groups AS bg ON b.brands_group_id = bg.id
				WHERE b.mongodb_id = ?
				LIMIT 1`;

				const [rows] = await connection.execute(query, [cleanIoId]);

				if (Array.isArray(rows) && rows.length > 0) {
					const row = rows[0] as { brand_group_id: number; brand_group_name: string };
					brandGroups.set(ioId, {
						brand_group_id: row.brand_group_id,
						brand_group_name: row.brand_group_name,
					});
				} else {
					// Query succeeded but returned no rows
					brandGroups.set(ioId, {
						brand_group_id: 'NotFoundBrandGroupID',
						brand_group_name: 'Unknown Brand',
					});
					brandGroupErrors[ioId] = `No rows returned from query for mongodb_id: '${cleanIoId}' (database: ${boDatabase})`;
				}
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				brandGroups.set(ioId, {
					brand_group_id: 'NotFoundBrandGroupID',
					brand_group_name: 'Unknown Brand',
				});
				brandGroupErrors[ioId] = `Database error: ${errorMessage}`;
			}
		}

		await connection.end();
		const mysqlQueryDuration = Date.now() - mysqlQueryStart;

		// Process each brand
		const uploads: UploadResult[] = [];
		let totalRowsInput = 0;
		let totalRowsAfterDedup = 0;
		let totalDuplicatesRemoved = 0;
		let totalSizeKb = 0;
		let s3UploadTotalMs = 0;
		const dedupStart = Date.now();

		for (const ioId of ioIds) {
			const brandGroup = brandGroups.get(ioId)!;

			// Filter items for this brand
			let brandItems = items;
			if (uploadType === 'Processed') {
				brandItems = items.filter((item) => item.json.io_id === ioId);
			}

			totalRowsInput += brandItems.length;

			// Deduplicate by complete object
			const deduplicateResult = deduplicateByCompleteObject(
				brandItems.map((item) => item.json),
			);

			const uniqueRecords = deduplicateResult.unique;
			const duplicatesRemoved = deduplicateResult.duplicatesRemoved;

			totalRowsAfterDedup += uniqueRecords.length;
			totalDuplicatesRemoved += duplicatesRemoved;

			// Generate CSV
			const csv = generateCSV(uniqueRecords);
			const sizeKb = Math.round((Buffer.byteLength(csv, 'utf8') / 1024) * 100) / 100;
			totalSizeKb += sizeKb;

			// Generate S3 path
			const fileName = `${ioId}_${scriptId}_${uploadType}.csv`;
			const s3Key = `AutomationDiscrepancy/${year}/${month}/${brandGroup.brand_group_id}/${fileName}`;

			const uploadResult: UploadResult = {
				type: uploadType,
				io_id: ioId,
				script_id: scriptId,
				brand_group_id: brandGroup.brand_group_id,
				brand_group_name: brandGroup.brand_group_name,
				rows_input: brandItems.length,
				rows_after_dedup: uniqueRecords.length,
				duplicates_removed: duplicatesRemoved,
				size_kb: sizeKb,
				upload_success: false,
			};

			if (dryRun) {
				uploadResult.would_upload_to = s3Key;
				uploadResult.upload_success = false;
				uploadResult.dry_run = true;
			} else {
				// Upload to S3
				const uploadStart = Date.now();
				try {
					await s3
						.putObject({
							Bucket: s3BucketName,
							Key: s3Key,
							Body: csv,
							ContentType: 'text/csv',
						})
						.promise();

					const uploadDuration = Date.now() - uploadStart;
					s3UploadTotalMs += uploadDuration;

					uploadResult.path = s3Key;
					uploadResult.s3_url = `s3://${s3BucketName}/${s3Key}`;
					uploadResult.console_url = `https://s3.console.aws.amazon.com/s3/object/${s3BucketName}?prefix=${s3Key}`;
					uploadResult.upload_duration_ms = uploadDuration;
					uploadResult.upload_success = true;
				} catch (err) {
					uploadResult.upload_success = false;
					if (err instanceof Error) {
						throw new NodeOperationError(this.getNode(), `S3 Upload Error: ${err.message}`);
					}
				}
			}

			uploads.push(uploadResult);
		}

		const dedupDuration = Date.now() - dedupStart;
		const totalDuration = Date.now() - startTime;

		// Build output
		const output = {
			execution: {
				mode: 'monthly',
				upload_type: uploadType,
				script_id: scriptId,
				timestamp: new Date().toISOString(),
				duration_ms: totalDuration,
				year_month: yearMonth,
				...(dryRun && { dry_run: true }),
			},
			summary: {
				files_created: dryRun ? 0 : uploads.filter((u) => u.upload_success).length,
				...(dryRun && { would_create_files: ioIds.length }),
				total_rows_input: totalRowsInput,
				total_rows_after_dedup: totalRowsAfterDedup,
				total_duplicates_removed: totalDuplicatesRemoved,
				total_size_kb: totalSizeKb,
				brands_processed: ioIds.length,
				...(dryRun && { status: 'DRY_RUN_SKIPPED' }),
			},
			uploads,
			metrics: {
				mysql_queries_ms: mysqlQueryDuration,
				deduplication_ms: dedupDuration,
				...(s3UploadTotalMs > 0 && { s3_upload_total_ms: s3UploadTotalMs }),
			},
			...(Object.keys(brandGroupErrors).length > 0 && { brand_group_errors: brandGroupErrors }),
		};

		return [[{ json: output }]];
	}
}

// Helper function to deduplicate by complete object
function deduplicateByCompleteObject(
	items: Record<string, unknown>[],
): { unique: Record<string, unknown>[]; duplicatesRemoved: number } {
	const uniqueRecords: Record<string, unknown>[] = [];
	const seen = new Set<string>();

	for (const item of items) {
		// Sort keys for consistent comparison
		const sortedItem: Record<string, unknown> = {};
		Object.keys(item)
			.sort()
			.forEach((key) => {
				sortedItem[key] = item[key];
			});

		const recordString = JSON.stringify(sortedItem);

		if (!seen.has(recordString)) {
			seen.add(recordString);
			uniqueRecords.push(item);
		}
	}

	return {
		unique: uniqueRecords,
		duplicatesRemoved: items.length - uniqueRecords.length,
	};
}

// Helper function to generate CSV
function generateCSV(records: Record<string, unknown>[]): string {
	if (records.length === 0) {
		return '';
	}

	// Headers from first record keys
	const headers = Object.keys(records[0]).join(',');

	// Rows
	const rows = records.map((record) => {
		return Object.values(record)
			.map((value) => {
				// Escape quotes and wrap in quotes if contains comma or quote
				if (
					typeof value === 'string' &&
					(value.includes(',') || value.includes('"') || value.includes('\n'))
				) {
					return `"${value.replace(/"/g, '""')}"`;
				}
				return value;
			})
			.join(',');
	});

	return [headers, ...rows].join('\n');
}
