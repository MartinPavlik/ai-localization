# AI Translations

A robust library for translating frontend localization files using OpenAI's Assistant API with intelligent change detection and automatic error recovery.

## Overview

This library automates the translation of localization files across multiple languages with smart detection of what needs translation. It works by:

1. **Smart Detection**: Combines two approaches to find keys that need translation:
   - Detects changes in your source file using `git diff`
   - Compares source and target files to find missing keys
2. **Intelligent Processing**: Sends only the necessary keys to OpenAI's Assistant API
3. **Multi-language Support**: Generates translations for multiple target languages in parallel
4. **Error Recovery**: Automatically handles rate limits and API errors with retry logic
5. **Detailed Logging**: Provides comprehensive progress updates and error reporting

For new projects or complete retranslations, you can use the `recreate: true` option to generate translations from scratch.

## Expected structure of the source files

The source translations need to have this structure:

```json
{
  "key": "value"
}
```

The output translations will have the same structure:

```json
{
  "key": "value"
}
```

### Example

So for example if you have this source file:

en.json:
```json
{
  "hello": "Hello"
}
```

It will generate the following translations:
cs.json:
```json
{
  "hello": "Ahoj"
}
```

pl.json:
```json
{
  "hello": "Cześć"
}
```

de.json:
```json
{
  "hello": "Hallo"
}
```


## Installation

```
npm install @satankebab/ai-localization
# or
yarn add @satankebab/ai-localization
```

## Features

### 🎯 Smart Translation Detection
- Combines git diff and file comparison to find exactly what needs translation
- Avoids retranslating unchanged content
- Handles cases where source and target are the same file

### 🔄 Automatic Rate Limit Handling
- Detects OpenAI rate limit errors automatically
- Extracts wait time from error messages (e.g., "try again in 1.362s")
- Retries with appropriate delays (up to 5 attempts by default)
- Uses exponential backoff when wait time is not specified

### 🛡️ Robust Error Recovery
- Continues processing other chunks if one fails
- Collects all errors and displays detailed report at the end
- Shows exactly what was sent to and received from the API
- Includes full stack traces for debugging

### 📊 Comprehensive Logging
- Color-coded console output for easy reading
- Shows progress for each file and chunk
- Displays statistics: changed keys, missing keys, translated keys
- Reports rate limit waits and retry attempts

### ⚡ Performance Optimized
- Parallel processing of multiple files
- Configurable chunk sizes to optimize API calls
- Adjustable parallelism limits

## Basic Usage

The following example demonstrates how to translate an English source file (`en.json`) to German, Czech, and Polish:

```ts
import { generateTranslations } from "@satankebab/ai-localization";
import dotenv from "dotenv";

dotenv.config();

const outputFiles = [
  "de.json",
  "cs.json",
  "pl.json",
];

generateTranslations({
  assistantId: process.env.OPENAI_API_ASSISTANT_ID || '',
  openAiApiKey: process.env.OPENAI_API_KEY || '',
  productContext: `
    This is a web application for managing screen recordings.
    The tone is professional but friendly, and technical terms should be preserved.
  `,
  extraContextByFilename: {
    "cs.json": "Translate the following JSON to Czech language. Maintain any technical terms.",
    "pl.json": "Translate the following JSON to Polish language. Maintain any technical terms.",
    "de.json": "Translate the following JSON to German language. Maintain any technical terms.",
  },
  sourceFile: "en.json",
  sourceDirectory: "../../frontend/localization/locales",
  outputFiles,
  outputDirectory: "../../frontend/localization/locales",
  recreate: false,
  parallelLimit: 10,  // Process up to 10 files in parallel
  chunkSize: 3000,    // Send 3000 keys per API call
});
```

## Advanced Usage

### Custom Parallelism and Chunking

For large translation files or to optimize API usage:

```ts
generateTranslations({
  // ... other options
  parallelLimit: 5,   // Reduce parallelism to avoid rate limits
  chunkSize: 1000,    // Smaller chunks for more granular progress
});
```

### Full Retranslation

To retranslate everything from scratch:

```ts
generateTranslations({
  // ... other options
  recreate: true,  // Translates all keys regardless of git diff or existing translations
});
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `assistantId` | `string` | *required* | The ID of your OpenAI assistant |
| `openAiApiKey` | `string` | *required* | Your OpenAI API key |
| `productContext` | `string` | *required* | Project context that helps the AI understand your application domain |
| `extraContextByFilename` | `Record<string, string>` | *required* | Language-specific instructions for each output file |
| `sourceFile` | `string` | *required* | The source language file (e.g., `en.json`) |
| `sourceDirectory` | `string` | *required* | Directory containing the source file |
| `outputFiles` | `string[]` | *required* | Array of target language files to generate |
| `outputDirectory` | `string` | *required* | Directory where translated files will be saved |
| `recreate` | `boolean` | `false` | When `true`, translates all keys; when `false`, only translates changed + missing keys |
| `parallelLimit` | `number` | `10` | Number of files to process in parallel |
| `chunkSize` | `number` | `3000` | Number of translation keys to process per API call |

## How It Works

The library intelligently determines what needs to be translated:

### Normal Mode (`recreate: false`)
1. **Reads the source file** (e.g., `en.json`)
2. **Detects changed keys** using `git diff` on the source file
3. **For each target file** (e.g., `pt.json`, `es.json`):
   - Compares source and target to find missing keys
   - Combines changed keys + missing keys into a set to translate
   - Only translates what's needed for that specific file
4. **Processes translations** in parallel with configurable chunking
5. **Handles errors gracefully**:
   - Automatically retries on rate limits with smart wait times
   - Continues processing other chunks if one fails
   - Provides detailed error reports at the end
6. **Merges translations** with existing target files

### Recreate Mode (`recreate: true`)
Translates all keys from the source file to all target files, useful for:
- Initial setup of translation files
- Complete retranslation after major changes
- Starting fresh with updated translation guidelines

### Smart Scenarios Handled

**Scenario 1: Source file is also an output file**
```
Source: en.json (you added "newKey")
Outputs: [en.json, pt.json, es.json]
→ Git diff detects "newKey"
→ Translates "newKey" to pt.json and es.json
→ en.json already has it, so nothing translated there
```

**Scenario 2: Target file is outdated**
```
Git diff: (no changes)
pt.json: missing 10 keys from en.json
→ Translates only the 10 missing keys
```

**Scenario 3: Both changed and missing**
```
Git diff: 2 changed keys
pt.json: missing 5 keys
→ Translates 7 keys total (union of both sets)
```

## Example Console Output

When running, you'll see detailed progress information:

```
🔧 Translation Configuration:
   Assistant ID: asst_xxxxx
   Source File: en.json
   Recreate Mode: No
   Parallel Limit: 10
   Chunk Size: 3000

📖 Reading source file: ./locales/en.json
📊 Source file contains 150 keys

🔍 Executing: git diff ./locales/en.json
🔄 Git diff detected 3 changed keys

📖 pt.json: Loaded existing file with 140 keys
🔄 pt.json: Found 13 keys to translate (3 changed, 10 missing)
🔄 pt.json: creating 1 chunks
🤖 pt.json: calling AI assistant for chunk 1 of 1
✅ pt.json: AI generated translations for chunk 1 of 1

✅ es.json: Already up to date, no keys to translate

📊 All translations generated successfully
📈 Number of translated keys per file:
   pt.json: 13 new keys translated
   es.json: 0 new keys translated

✅ All translations completed successfully with no errors!
```

### Rate Limit Handling

If rate limits are hit, you'll see automatic retries:

```
⏳ Rate limit exceeded. Waiting 1.9s before retry (attempt 1/5)...
   Rate limit reached for gpt-4.1 on tokens per min (TPM): Limit 30000, Used 29361, Requested 1320. Please try again in 1.362s.
```

### Error Reporting

If errors occur, a detailed summary is shown at the end:

```
═══════════════════════════════════════════════════════════
❌ TRANSLATION ERRORS SUMMARY (2 total)
═══════════════════════════════════════════════════════════

─────────────── Error 1 of 2 ───────────────
📁 File: pt.json
📦 Chunk: 2 of 3
❗ Error: Failed to parse JSON response

📤 Sent to API:
Prompt: You are a professional translator...
Chunk data:
{
  "key1": "value1",
  "key2": "value2"
}

📥 Received from API:
{invalid json response...

🔍 Raw Error Details:
Unexpected token 'i', "{invalid js"... is not valid JSON
```

## Troubleshooting

### Git Diff Not Working

If git diff fails (e.g., not in a git repository), the library will automatically fall back to comparing source and target files only. You'll see:

```
⚠️  Git diff failed or not available: Command failed...
   Will only translate missing keys based on file comparison
```

### Rate Limits

The library automatically handles rate limits with up to 5 retry attempts. To reduce rate limit issues:
- Reduce `parallelLimit` (e.g., `parallelLimit: 5`)
- Increase `chunkSize` to make fewer API calls (e.g., `chunkSize: 5000`)

### Large Files

For very large translation files (1000+ keys):
- Increase `chunkSize` to reduce API call count
- The library will show progress per chunk
- Failed chunks won't stop other chunks from processing

## Sponsored by

This library is sponsored by [ScreenManager](https://screenmanager.tech) - Digital Signage CMS.
