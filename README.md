# AI Translations

A robust library for translating frontend localization files using OpenAI's Assistant API.

## Overview

This library automates the translation of localization files across multiple languages. It works by:

1. Detecting changes in your source language file using `git diff`
2. Sending these changes to OpenAI's language model
3. Generating corresponding translations for your target languages

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
});
```

## Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `assistantId` | `string` | The ID of your OpenAI assistant |
| `openAiApiKey` | `string` | Your OpenAI API key |
| `productContext` | `string` | Project context that helps the AI understand your application domain |
| `extraContextByFilename` | `Record<string, string>` | Language-specific instructions for each output file |
| `sourceFile` | `string` | The source language file (e.g., `en.json`) |
| `sourceDirectory` | `string` | Directory containing the source file |
| `outputFiles` | `string[]` | Array of target language files to generate |
| `outputDirectory` | `string` | Directory where translated files will be saved |
| `recreate` | `boolean` | When `true`, generates translations from scratch instead of updating existing files |

## How It Works

The library:
1. Reads the source file from the specified directory
2. If `recreate` is `false`, uses `git diff` to identify changes since the last commit
3. Sends the content or changes to OpenAI's Assistant API with your provided context
4. Generates translations for each target language
5. Writes the translated content to the specified output files

## Sponsored by

This library is sponsored by [ScreenManager](https://screenmanager.tech) - Digital Signage CMS.
