# Ryze Monthly Uploader - Custom n8n Node Specification

## Overview

A custom n8n node that uploads CSV files to AWS S3 for monthly discrepancy analysis. This node handles both Translated (raw fetcher data) and Processed (after processor rules) data, with automatic multi-brand support and complete object deduplication.

---

## Node Information

**Package Name:** `n8n-nodes-ryze-monthly-uploader`  
**Node Name:** `ryzeMonthlyUploader`  
**Display Name:** `Ryze Monthly Uploader`  
**Category:** Transform  
**Icon:** Blue "R" with calendar/upload symbol  

---

## Purpose

Upload monthly data to S3 for discrepancy analysis between internal tracking and partner reports. Runs on the 2nd of each month at 03:00 UTC, processing the previous month's data.

---

## Input Schema

The node accepts items in the standard 9-field format (for Processed) or any format (for Translated):

### **Processed Data Format:**
```javascript
{
  "date": "2025-12-05T12:00:00",
  "token": "648db097a5a4",
  "event": "canceled-lead",
  "trx_id": "Aircall-canceled-lead-648db097a5a4",
  "io_id": "eab7e510-eb50-11e9-b544-fb4e13fb7f1d",  // ← AUTO-DETECTED
  "commission_amount": -520,
  "amount": "0",
  "currency": "USD",
  "parent_api_call": "partnerstack-reward-created"
}
```

### **Translated Data Format:**
```javascript
{
  "date": "2025-12-05",
  "token": "648db097a5a4",
  "amount": 500,
  "commission": 100,
  // ... any other fields from fetcher
  // NO io_id field (will use parameter)
}
```

---

## Node Parameters

### **Required Parameters**

#### 1. Upload Type
- **Type:** Options
- **Required:** Yes
- **Options:**
  - `Translated` - Data from fetcher/translator (before processors)
  - `Processed` - Data after processor rules applied
- **Description:** Type of data being uploaded

#### 2. Script ID
- **Type:** String
- **Required:** Yes
- **Description:** Your scraper script ID
- **Example:** `"3000"`
- **Placeholder:** `"3000"`

#### 3. IO ID (Only for Translated)
- **Type:** String
- **Required:** Yes (only when Upload Type = Translated)
- **Description:** Brand identifier - required for Translated, auto-detected for Processed
- **Example:** `"eab7e510-eb50-11e9-b544-fb4e13fb7f1d"`
- **Display Condition:** Only shown when Upload Type = "Translated"

### **Optional Parameters**

#### 4. Year/Month Override
- **Type:** String (YYYY/MM format)
- **Required:** No
- **Default:** Previous month (auto-calculated)
- **Description:** Override automatic date calculation for manual reruns
- **Example:** `"2025/11"`
- **Placeholder:** `"Leave empty for auto (previous month)"`

#### 5. Options Collection

**S3 Bucket Name** (string, default: "ryze-data-brand-performance")
- AWS S3 bucket for uploads

**BO MySQL Database** (string, default: "bo")
- Database name for brand_group lookup

**Dry Run Mode** (boolean, default: false)
- Test mode - generates CSV and checks brand_group but doesn't upload to S3

**Verbose Logging** (boolean, default: false)
- Include detailed debug information in output

---

## Credentials

### **AWS S3 Credential (Required)**
```javascript
{
  type: "aws",
  name: "AWS Credential",
  properties: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1"
  }
}
```

### **MySQL Credential (Required)**
```javascript
{
  type: "mySql",
  name: "BO MySQL Account",
  properties: {
    host: "bo-db.amazonaws.com",
    port: 3306,
    database: "bo",
    user: "your-user",
    password: "your-password"
  }
}
```

---

## Processing Logic

### **Step 1: Determine Year/Month**

```javascript
// If yearMonthOverride provided:
const [year, month] = yearMonthOverride.split('/'); // e.g., "2025/11"

// Otherwise, calculate previous month:
const now = new Date();
const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const year = previousMonth.getFullYear().toString();  // "2025"
const month = (previousMonth.getMonth() + 1).toString().padStart(2, '0');  // "11"
```

---

### **Step 2: Get IO ID**

**For Translated:**
```javascript
const ioId = parameters.ioId;  // From node parameter (user specifies)
```

**For Processed:**
```javascript
// Auto-detect from data
const ioIds = [...new Set(items.map(item => item.json.io_id))];
// Multiple io_ids = multiple files (multi-brand support)
```

---

### **Step 3: Query Brand Group ID**

For each unique io_id:

```sql
SELECT 
  bg.id as brand_group_id, 
  bg.name as brand_group_name 
FROM bo.out_brands AS b 
LEFT JOIN bo.brands_groups AS bg ON b.brands_group_id = bg.id 
WHERE b.mongodb_id = ? 
LIMIT 1;
```

**Example Result:**
```javascript
{
  brand_group_id: 123,
  brand_group_name: "Casino Brands Group"
}
```

**If not found:**
```javascript
{
  brand_group_id: "NotFoundBrandGroupID",
  brand_group_name: "Unknown Brand"
}
```

---

### **Step 4: Deduplicate by Complete Object**

Remove exact duplicate records (all fields must match):

```javascript
function deduplicateByCompleteObject(items) {
  const uniqueRecords = [];
  const seen = new Set();
  
  for (const item of items) {
    // Sort keys for consistent comparison
    const sortedItem = {};
    Object.keys(item).sort().forEach(key => {
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
    duplicatesRemoved: items.length - uniqueRecords.length
  };
}
```

**Example:**
```javascript
Input: [
  {date: "2025-12-05T12:00:00", token: "abc", amount: 500, commission: 100},
  {date: "2025-12-05T12:00:00", token: "abc", amount: 500, commission: 100}, // DUPLICATE
  {date: "2025-12-05T12:00:00", token: "abc", amount: 500, commission: 105}  // NOT DUPLICATE
]

Output: {
  unique: [
    {date: "2025-12-05T12:00:00", token: "abc", amount: 500, commission: 100},
    {date: "2025-12-05T12:00:00", token: "abc", amount: 500, commission: 105}
  ],
  duplicatesRemoved: 1
}
```

---

### **Step 5: Generate CSV**

Convert deduplicated JSON to CSV format:

```javascript
// Headers from first record keys
const headers = Object.keys(uniqueRecords[0]).join(',');

// Rows
const rows = uniqueRecords.map(record => {
  return Object.values(record).map(value => {
    // Escape quotes and wrap in quotes if contains comma
    if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }).join(',');
});

const csv = [headers, ...rows].join('\n');
```

**Example CSV Output:**
```csv
date,token,event,trx_id,io_id,commission_amount,amount,currency,parent_api_call
2025-12-05T12:00:00,abc123,sale,brand-sale-123,eab7...,100,500,USD,Empty
2025-12-05T12:00:00,def456,lead,brand-lead-456,eab7...,0,0,USD,partnerstack
```

---

### **Step 6: Generate S3 File Path**

**Path Format:**
```
AutomationDiscrepancy/YYYY/MM/<BrandGroupID>/<IOID>_<ScriptID>_<Type>.csv
```

**Components:**
- `YYYY` - Year (4 digits): 2025
- `MM` - Month (2 digits): 11
- `BrandGroupID` - From database query: 123
- `IOID` - Brand identifier: eab7e510-eb50-11e9-b544-fb4e13fb7f1d
- `ScriptID` - From parameter: 3000
- `Type` - "Translated" or "Processed"

**Examples:**

**Translated:**
```
AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Translated.csv
```

**Processed (single brand):**
```
AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Processed.csv
```

**Processed (multi-brand - 3 files):**
```
AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Processed.csv
AutomationDiscrepancy/2025/11/456/545f8472fe0af42e7bbb6903_3000_Processed.csv
AutomationDiscrepancy/2025/11/789/abc123def456ghi789jkl012mno345pqr_3000_Processed.csv
```

---

### **Step 7: Upload to S3**

```javascript
await s3.putObject({
  Bucket: s3BucketName,
  Key: filePath,
  Body: csvContent,
  ContentType: 'text/csv'
}).promise();
```

**S3 URL Format:**
```
s3://ryze-data-brand-performance/AutomationDiscrepancy/2025/11/123/eab7..._3000_Translated.csv
```

**Console URL (for easy access):**
```
https://s3.console.aws.amazon.com/s3/object/ryze-data-brand-performance?prefix=AutomationDiscrepancy/2025/11/123/eab7..._3000_Translated.csv
```

---

## Output Schema

### **Single File Upload (Translated or Single-Brand Processed)**

```javascript
{
  "execution": {
    "mode": "monthly",
    "upload_type": "Translated",
    "script_id": "3000",
    "timestamp": "2025-12-02T03:00:00.000Z",
    "duration_ms": 2341,
    "year_month": "2025/11"
  },
  "summary": {
    "files_created": 1,
    "total_rows_input": 150,
    "total_rows_after_dedup": 142,
    "total_duplicates_removed": 8,
    "total_size_kb": 42,
    "brands_processed": 1
  },
  "uploads": [
    {
      "type": "Translated",
      "io_id": "eab7e510-eb50-11e9-b544-fb4e13fb7f1d",
      "script_id": "3000",
      "brand_group_id": 123,
      "brand_group_name": "Casino Brands Group",
      "path": "AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Translated.csv",
      "s3_url": "s3://ryze-data-brand-performance/AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Translated.csv",
      "console_url": "https://s3.console.aws.amazon.com/s3/object/ryze-data-brand-performance?prefix=AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Translated.csv",
      "rows_input": 150,
      "rows_after_dedup": 142,
      "duplicates_removed": 8,
      "size_kb": 42,
      "upload_duration_ms": 456,
      "upload_success": true
    }
  ],
  "metrics": {
    "mysql_queries_ms": 120,
    "deduplication_ms": 89,
    "csv_generation_ms": 234,
    "s3_upload_total_ms": 456
  }
}
```

---

### **Multi-Brand Upload (Processed with 3 Brands)**

```javascript
{
  "execution": {
    "mode": "monthly",
    "upload_type": "Processed",
    "script_id": "3000",
    "timestamp": "2025-12-02T03:00:00.000Z",
    "duration_ms": 4523,
    "year_month": "2025/11"
  },
  "summary": {
    "files_created": 3,
    "total_rows_input": 150,
    "total_rows_after_dedup": 138,
    "total_duplicates_removed": 12,
    "total_size_kb": 114,
    "brands_processed": 3
  },
  "uploads": [
    {
      "type": "Processed",
      "io_id": "eab7e510-eb50-11e9-b544-fb4e13fb7f1d",
      "script_id": "3000",
      "brand_group_id": 123,
      "brand_group_name": "Casino Brands Group",
      "path": "AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Processed.csv",
      "s3_url": "s3://ryze-data-brand-performance/AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Processed.csv",
      "console_url": "https://s3.console.aws.amazon.com/s3/object/ryze-data-brand-performance?prefix=AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Processed.csv",
      "rows_input": 50,
      "rows_after_dedup": 48,
      "duplicates_removed": 2,
      "size_kb": 38,
      "upload_duration_ms": 342,
      "upload_success": true
    },
    {
      "type": "Processed",
      "io_id": "545f8472fe0af42e7bbb6903",
      "script_id": "3000",
      "brand_group_id": 456,
      "brand_group_name": "B2B Brands Group",
      "path": "AutomationDiscrepancy/2025/11/456/545f8472fe0af42e7bbb6903_3000_Processed.csv",
      "s3_url": "s3://ryze-data-brand-performance/AutomationDiscrepancy/2025/11/456/545f8472fe0af42e7bbb6903_3000_Processed.csv",
      "console_url": "https://s3.console.aws.amazon.com/s3/object/ryze-data-brand-performance?prefix=AutomationDiscrepancy/2025/11/456/545f8472fe0af42e7bbb6903_3000_Processed.csv",
      "rows_input": 75,
      "rows_after_dedup": 72,
      "duplicates_removed": 3,
      "size_kb": 51,
      "upload_duration_ms": 389,
      "upload_success": true
    },
    {
      "type": "Processed",
      "io_id": "abc123def456ghi789jkl012mno345pqr",
      "script_id": "3000",
      "brand_group_id": 789,
      "brand_group_name": "Dating Brands Group",
      "path": "AutomationDiscrepancy/2025/11/789/abc123def456ghi789jkl012mno345pqr_3000_Processed.csv",
      "s3_url": "s3://ryze-data-brand-performance/AutomationDiscrepancy/2025/11/789/abc123def456ghi789jkl012mno345pqr_3000_Processed.csv",
      "console_url": "https://s3.console.aws.amazon.com/s3/object/ryze-data-brand-performance?prefix=AutomationDiscrepancy/2025/11/789/abc123def456ghi789jkl012mno345pqr_3000_Processed.csv",
      "rows_input": 25,
      "rows_after_dedup": 25,
      "duplicates_removed": 0,
      "size_kb": 25,
      "upload_duration_ms": 234,
      "upload_success": true
    }
  ],
  "metrics": {
    "mysql_queries_ms": 356,
    "deduplication_ms": 145,
    "csv_generation_ms": 678,
    "s3_upload_total_ms": 965
  }
}
```

---

### **Dry Run Output**

```javascript
{
  "execution": {
    "mode": "monthly",
    "upload_type": "Processed",
    "script_id": "3000",
    "timestamp": "2025-12-02T03:00:00.000Z",
    "duration_ms": 1234,
    "year_month": "2025/11",
    "dry_run": true
  },
  "summary": {
    "files_created": 0,
    "would_create_files": 3,
    "total_rows_input": 150,
    "total_rows_after_dedup": 138,
    "total_duplicates_removed": 12,
    "total_size_kb": 114,
    "brands_processed": 3,
    "status": "DRY_RUN_SKIPPED"
  },
  "uploads": [
    {
      "type": "Processed",
      "io_id": "eab7e510-eb50-11e9-b544-fb4e13fb7f1d",
      "script_id": "3000",
      "brand_group_id": 123,
      "brand_group_name": "Casino Brands Group",
      "would_upload_to": "AutomationDiscrepancy/2025/11/123/eab7e510-eb50-11e9-b544-fb4e13fb7f1d_3000_Processed.csv",
      "rows_after_dedup": 48,
      "duplicates_removed": 2,
      "size_kb": 38,
      "upload_success": false,
      "dry_run": true
    }
    // ... other brands
  ],
  "metrics": {
    "mysql_queries_ms": 356,
    "deduplication_ms": 145,
    "csv_generation_ms": 678
  }
}
```

---

### **Error Output**

```javascript
{
  "execution": {
    "mode": "monthly",
    "upload_type": "Processed",
    "script_id": "3000",
    "timestamp": "2025-12-02T03:00:00.000Z",
    "duration_ms": 567,
    "success": false
  },
  "error": {
    "code": "S3_UPLOAD_ERROR",
    "message": "Failed to upload to S3",
    "details": "Access Denied - check AWS credentials",
    "stage": "s3_upload",
    "affected_file": "AutomationDiscrepancy/2025/11/123/eab7..._3000_Processed.csv"
  },
  "summary": {
    "files_created": 1,
    "files_failed": 2,
    "total_rows_input": 150
  },
  "partial_uploads": [
    {
      "io_id": "eab7e510-eb50-11e9-b544-fb4e13fb7f1d",
      "upload_success": true
    }
  ],
  "failed_uploads": [
    {
      "io_id": "545f8472fe0af42e7bbb6903",
      "error": "Access Denied",
      "brand_group_id": 456
    },
    {
      "io_id": "abc123def456ghi789jkl012mno345pqr",
      "error": "Access Denied",
      "brand_group_id": 789
    }
  ]
}
```

---

## Database Schema

### bo.out_brands Table
```sql
CREATE TABLE bo.out_brands (
  id INT PRIMARY KEY,
  mongodb_id VARCHAR(255) UNIQUE,
  name VARCHAR(255),
  brands_group_id INT,
  -- other fields...
);
```

### bo.brands_groups Table
```sql
CREATE TABLE bo.brands_groups (
  id INT PRIMARY KEY,
  name VARCHAR(255),
  -- other fields...
);
```

---

## Workflow Integration

### **Usage Pattern: TWO Nodes in Workflow**

```
Schedule Trigger (hourly: 32 7-18 * * *)
    ↓
Monthly Trigger (2nd @ 03:00 UTC: 0 3 2 * *)
    ↓
FETCHER (with date range logic)
    ↓
TRANSLATOR (normalize data)
    ↓ ┌─────────────────────────────────────┐
      │                                     │
      ▼                                     ▼
IF Monthly Trigger Executed?         PROCESSORS
      │                                     │
      │ TRUE                                ▼
      ▼                               Merge Processors
┌──────────────────────────┐              │
│ Ryze Monthly Uploader    │              ▼
│                          │        IF Monthly Trigger Executed?
│ Upload Type: Translated  │              │
│ Script ID: 3000          │              │ TRUE
│ IO ID: eab7e510-eb50-... │              ▼
│                          │        ┌──────────────────────────┐
│ Credentials:             │        │ Ryze Monthly Uploader    │
│  - AWS S3                │        │                          │
│  - BO MySQL              │        │ Upload Type: Processed   │
└──────────────────────────┘        │ Script ID: 3000          │
      │                             │ IO ID: (auto from data)  │
      │                             │                          │
      ▼                             │ Credentials:             │
IF NOT Monthly → Ryze Pixel Sender  │  - AWS S3                │
                                    │  - BO MySQL              │
                                    └──────────────────────────┘
                                              │
                                              ▼
                                    IF NOT Monthly → Ryze Pixel Sender
```

---

## Configuration Examples

### **Example 1: Translated Upload (Single Brand)**

**Node Configuration:**
```javascript
{
  uploadType: "Translated",
  scriptId: "3000",
  ioId: "eab7e510-eb50-11e9-b544-fb4e13fb7f1d",
  yearMonthOverride: null,  // Auto: previous month
  dryRun: false
}
```

**Result:**
- 1 file uploaded
- Path: `AutomationDiscrepancy/2025/11/123/eab7..._3000_Translated.csv`

---

### **Example 2: Processed Upload (Multi-Brand)**

**Node Configuration:**
```javascript
{
  uploadType: "Processed",
  scriptId: "3000",
  ioId: null,  // Not needed - auto-detected from data
  yearMonthOverride: null,
  dryRun: false
}
```

**Input Data Contains:**
- 50 items with io_id: "eab7..."
- 75 items with io_id: "545f..."
- 25 items with io_id: "abc1..."

**Result:**
- 3 files uploaded (one per brand)
- Paths:
  - `AutomationDiscrepancy/2025/11/123/eab7..._3000_Processed.csv`
  - `AutomationDiscrepancy/2025/11/456/545f..._3000_Processed.csv`
  - `AutomationDiscrepancy/2025/11/789/abc1..._3000_Processed.csv`

---

### **Example 3: Manual Rerun (Specific Month)**

**Node Configuration:**
```javascript
{
  uploadType: "Processed",
  scriptId: "3000",
  yearMonthOverride: "2025/10",  // Rerun October data
  dryRun: false
}
```

**Result:**
- Uploads to October folder instead of November
- Path: `AutomationDiscrepancy/2025/10/123/eab7..._3000_Processed.csv`

---

### **Example 4: Dry Run Test**

**Node Configuration:**
```javascript
{
  uploadType: "Translated",
  scriptId: "3000",
  ioId: "eab7e510-eb50-11e9-b544-fb4e13fb7f1d",
  dryRun: true  // Test mode
}
```

**Result:**
- No files uploaded to S3
- Output shows what would be uploaded
- Useful for testing before monthly run

---

## Logging Examples

### **Console Output (Verbose Mode)**

```
[Ryze Monthly Uploader] Script: 3000
[Ryze Monthly Uploader] Upload Type: Processed
[Ryze Monthly Uploader] Year/Month: 2025/11
[Ryze Monthly Uploader] 
[Ryze Monthly Uploader] Received: 150 items
[Ryze Monthly Uploader] Detected io_ids: 3 brands
[Ryze Monthly Uploader]   • eab7e510-eb50-11e9-b544-fb4e13fb7f1d (50 items)
[Ryze Monthly Uploader]   • 545f8472fe0af42e7bbb6903 (75 items)
[Ryze Monthly Uploader]   • abc123def456ghi789jkl012mno345pqr (25 items)
[Ryze Monthly Uploader] 
[Ryze Monthly Uploader] Querying brand groups from MySQL...
[Ryze Monthly Uploader] ✓ Found 3 brand groups
[Ryze Monthly Uploader] 
[Ryze Monthly Uploader] Processing Brand 1/3:
[Ryze Monthly Uploader]   IO ID: eab7e510-eb50-11e9-b544-fb4e13fb7f1d
[Ryze Monthly Uploader]   Brand Group: 123 (Casino Brands Group)
[Ryze Monthly Uploader]   Items: 50 → 48 (2 duplicates removed)
[Ryze Monthly Uploader]   CSV Size: 38 KB
[Ryze Monthly Uploader]   Path: AutomationDiscrepancy/2025/11/123/eab7..._3000_Processed.csv
[Ryze Monthly Uploader]   ✓ Uploaded in 342ms
[Ryze Monthly Uploader] 
[Ryze Monthly Uploader] Processing Brand 2/3:
[Ryze Monthly Uploader]   IO ID: 545f8472fe0af42e7bbb6903
[Ryze Monthly Uploader]   Brand Group: 456 (B2B Brands Group)
[Ryze Monthly Uploader]   Items: 75 → 72 (3 duplicates removed)
[Ryze Monthly Uploader]   CSV Size: 51 KB
[Ryze Monthly Uploader]   Path: AutomationDiscrepancy/2025/11/456/545f..._3000_Processed.csv
[Ryze Monthly Uploader]   ✓ Uploaded in 389ms
[Ryze Monthly Uploader] 
[Ryze Monthly Uploader] Processing Brand 3/3:
[Ryze Monthly Uploader]   IO ID: abc123def456ghi789jkl012mno345pqr
[Ryze Monthly Uploader]   Brand Group: 789 (Dating Brands Group)
[Ryze Monthly Uploader]   Items: 25 → 25 (0 duplicates removed)
[Ryze Monthly Uploader]   CSV Size: 25 KB
[Ryze Monthly Uploader]   Path: AutomationDiscrepancy/2025/11/789/abc1..._3000_Processed.csv
[Ryze Monthly Uploader]   ✓ Uploaded in 234ms
[Ryze Monthly Uploader] 
[Ryze Monthly Uploader] Summary:
[Ryze Monthly Uploader]   Files Created: 3
[Ryze Monthly Uploader]   Total Rows: 150 → 145 (5 duplicates)
[Ryze Monthly Uploader]   Total Size: 114 KB
[Ryze Monthly Uploader] 
[Ryze Monthly Uploader] ✓ Completed in 4.5s
```

---

## Error Handling

### **MySQL Connection Error**

```javascript
{
  error: {
    code: "MYSQL_CONNECTION_ERROR",
    message: "Failed to connect to BO database",
    details: "ECONNREFUSED",
    stage: "brand_group_lookup"
  }
}
```

### **Brand Group Not Found**

```javascript
// Continues with "NotFoundBrandGroupID" instead of failing
{
  uploads: [{
    brand_group_id: "NotFoundBrandGroupID",
    brand_group_name: "Unknown Brand",
    path: "AutomationDiscrepancy/2025/11/NotFoundBrandGroupID/eab7..._3000_Processed.csv"
  }]
}
```

### **S3 Upload Error**

```javascript
{
  error: {
    code: "S3_UPLOAD_ERROR",
    message: "Failed to upload file",
    details: "Access Denied - check IAM permissions",
    stage: "s3_upload",
    affected_file: "AutomationDiscrepancy/2025/11/123/eab7..._3000_Processed.csv"
  }
}
```

### **Partial Success**

If 2 out of 3 brands upload successfully:

```javascript
{
  summary: {
    files_created: 2,
    files_failed: 1
  },
  partial_uploads: [...],  // Successful ones
  failed_uploads: [...]    // Failed ones with errors
}
```

---

## Performance Considerations

### **Deduplication Performance**

```javascript
// For 10,000 items:
// Time: ~200ms

// For 100,000 items:
// Time: ~2s
```

### **S3 Upload Performance**

```javascript
// 50 KB file: ~200-400ms
// 500 KB file: ~1-2s
// 5 MB file: ~5-10s

// Multi-brand (3 files):
// Total: Sum of individual uploads + MySQL queries
```

### **Expected Total Duration**

- Small workflow (1 brand, 100 items): ~1-2s
- Medium workflow (3 brands, 500 items): ~3-5s
- Large workflow (5 brands, 2000 items): ~8-12s

---

## Testing Checklist

### **Unit Tests**

- [ ] Handles empty input
- [ ] Handles single item
- [ ] Handles 1000+ items
- [ ] Complete object deduplication works correctly
- [ ] Year/month calculation correct (previous month)
- [ ] Year/month override works
- [ ] Single brand (Translated) works
- [ ] Multi-brand (Processed) works
- [ ] Brand group lookup works
- [ ] Brand group not found handled gracefully
- [ ] CSV generation correct format
- [ ] S3 path generation correct
- [ ] MySQL connection failure handled
- [ ] S3 upload failure handled
- [ ] Partial success handled
- [ ] Dry run mode works

### **Integration Tests**

- [ ] Connects to real BO MySQL
- [ ] Queries brand_group_id correctly
- [ ] Connects to real AWS S3
- [ ] Uploads files successfully
- [ ] Files accessible in S3
- [ ] CSV format readable
- [ ] Multi-brand creates separate files
- [ ] Handles concurrent executions

---

## Migration from Sub-Workflow

### **Before (Sub-Workflow - 9 nodes):**

```
Execute Workflow Trigger
  ↓
Extract Input
  ↓
Get Brand Group ID (MySQL)
  ↓
Set Metadata with Brand Group
  ↓
Split Out Data
  ↓
Remove Duplicates
  ↓
Convert to CSV
  ↓
Upload to S3
  ↓
Return Success
```

### **After (Custom Node - 1 node):**

```
Ryze Monthly Uploader
```

### **Configuration:**

```javascript
{
  uploadType: "Translated" or "Processed",
  scriptId: "3000",
  ioId: "eab7..." (for Translated only)
}
```

---

## Credentials Used

| Service | Credential Type | Used For |
|---------|----------------|----------|
| AWS S3 | aws | Uploading CSV files |
| MySQL (BO) | mySql | Brand group lookup |

---

## Implementation Notes

### **Key Differences from Sub-Workflow:**

1. **Complete Object Deduplication**
   - Sub-workflow: Uses n8n's Remove Duplicates (field-based)
   - Custom node: Compares entire JSON object

2. **IO ID Handling**
   - Sub-workflow: Expects io_id in input
   - Custom node: Parameter for Translated, auto-detect for Processed

3. **Multi-Brand Support**
   - Sub-workflow: Single file per call
   - Custom node: Automatically groups by io_id, creates multiple files

4. **Error Handling**
   - Sub-workflow: Fails on any error
   - Custom node: Continues on partial success, reports all results

5. **Output**
   - Sub-workflow: Simple success message
   - Custom node: Detailed metrics, URLs, statistics

---

## Security Considerations

- ✅ AWS credentials stored securely in n8n
- ✅ MySQL credentials encrypted
- ✅ SQL injection prevention (parameterized queries)
- ✅ No sensitive data in logs
- ✅ S3 bucket access controlled by IAM

---

## Future Enhancements

- [ ] Compression support (gzip CSV files)
- [ ] Retry logic for failed S3 uploads
- [ ] Email notification on upload completion
- [ ] Support for other file formats (JSON, Parquet)
- [ ] Incremental uploads (append to existing files)
- [ ] Advanced deduplication rules
- [ ] S3 file versioning support

---

## Version History

**v0.1.0** - Initial release
- Translated and Processed upload types
- Complete object deduplication
- Multi-brand support
- Brand group lookup
- S3 upload with proper paths
- Dry run mode

---

**Questions? Contact: ohad.cohen@ryzebeyond.com**