import { promiseAllLimited } from "@satankebab/promise-all-limited";
import { execSync } from "child_process";
import fs from "fs";
import { OpenAI } from "openai";
import path from "path";
import chalk from "chalk";

const CHUNK_SIZE = 3000;
const PARALLEL_LIMIT = 10;


const callTsAiAssistant = async ({ content, assistant_id, client }: {
  content: string;
  assistant_id: string;
  client: OpenAI;
}) => {
  // Creates a thread and waits for the result
  const run = await client.beta.threads.createAndRunPoll({
    assistant_id,
    thread: {
      messages: [{ role: "user", content }],
    },
  });
  // Gets the last message from the thread
  const result = await (
    await client.beta.threads.messages.list(run.thread_id)
  ).data[0];
  // const entityFileContent = result.content[0].text.value;
  // return extractTypescriptMd(entityFileContent);

  // Fix: Safely access text value with type checking
  const messageContent = result.content[0];
  if ("text" in messageContent) {
    return messageContent.text.value;
  }
  throw new Error("Unexpected response format from OpenAI API");
};

const parseGitDiff = (diffOutput: string) => {
  const changes = {};
  const lines = diffOutput.split("\n");

  let contentStarted = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      contentStarted = true;
      continue;
    }

    if (!contentStarted) continue;

    // Only process lines that start with +
    if (line.startsWith("+")) {
      // Remove the + and any leading/trailing whitespace
      const cleanLine = line.slice(1).trim();

      // Skip empty lines or lines that don't look like JSON key-value pairs
      if (!cleanLine || !cleanLine.includes('":')) continue;

      // Remove trailing comma if it exists
      const jsonLine = cleanLine.endsWith(",")
        ? cleanLine.slice(0, -1)
        : cleanLine;

      try {
        // Extract key and value using regex instead of JSON.parse
        const matches = jsonLine.match(/"([^"]+)":\s*"([^"]+)"/);
        if (matches) {
          const [_, key, value] = matches;
          changes[key] = value;
        }
      } catch (e) {
        console.log("Failed to parse line:", jsonLine);
        continue;
      }
    }
  }

  return changes;
};

// Helper function to chunk the object into smaller pieces
const chunkObject = <T extends Record<string, unknown>>(obj: T, chunkSize): Partial<T>[] => {
  const entries = Object.entries(obj);
  const chunks: Partial<T>[] = [];

  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = Object.fromEntries(entries.slice(i, i + chunkSize)) as Partial<T>;
    chunks.push(chunk);
  }

  return chunks;
}

export const generateTranslations = ({
  openAiApiKey,
  assistantId,
  productContext,
  extraContextByFilename,
  sourceFile,
  sourceDirectory,
  outputFiles,
  outputDirectory,
  recreate = false,
  parallelLimit = PARALLEL_LIMIT,
  chunkSize = CHUNK_SIZE,
}: {
  openAiApiKey: string;
  assistantId: string;
  productContext: string;
  extraContextByFilename: Record<string, string>;
  sourceFile: string;
  sourceDirectory: string;
  outputFiles: string[];
  outputDirectory: string;
  recreate?: boolean;
  parallelLimit?: number;
  chunkSize?: number;
}) => {
  const aiClient = new OpenAI({ apiKey: openAiApiKey });

  // Log configuration (omitting API key)
  console.log(chalk.cyan('🔧 Translation Configuration:'));
  console.log(chalk.blue(`   Assistant ID: ${chalk.bold(assistantId)}`));
  console.log(chalk.blue(`   Source File: ${chalk.bold(sourceFile)}`));
  console.log(chalk.blue(`   Source Directory: ${chalk.bold(sourceDirectory)}`));
  console.log(chalk.blue(`   Output Directory: ${chalk.bold(outputDirectory)}`));
  console.log(chalk.blue(`   Output Files: ${chalk.bold(outputFiles.join(', '))}`));
  console.log(chalk.blue(`   Recreate Mode: ${chalk.bold(recreate ? 'Yes' : 'No')}`));
  console.log(chalk.blue(`   Parallel Limit: ${chalk.bold(parallelLimit.toString())}`));
  console.log(chalk.blue(`   Chunk Size: ${chalk.bold(chunkSize.toString())}`));
  
  const baseContext = `
    You are a professional translator that translates texts from english.

    Give me one json with the translations.
    Do not miss any keys (the number of keys must be the same as in the input json).
    
    ${productContext}
  `;

  const createFinalPrompt = (filename: string) => {
    const extraContext = extraContextByFilename[filename];
    if (!extraContext) {
      throw new Error(`No extra context found for filename: ${filename}`);
    }
    return `${baseContext}\n\n${extraContext}`;
  };


  const run = async () => {
    try {
      // Run git diff on the translations file
      const p = path.join(
        sourceDirectory,
        sourceFile
      );
      
      let changes;
      
      if (recreate) {
        // If recreate flag is set, read the entire file
        console.log(chalk.blue(`📖 Reading entire file: ${chalk.bold(p)}`));
        changes = JSON.parse(fs.readFileSync(p, { encoding: "utf8" }));
      } else {
        try {
          // Try to run git diff command
          const diffCommand = `git diff ${p}`;
          console.log(chalk.gray(`🔍 Executing: ${chalk.italic(diffCommand)}`));
          console.log(chalk.gray(`📂 Working directory: ${chalk.italic(sourceDirectory)}`));
          
          const diffOutput = execSync(diffCommand, {
            cwd: sourceDirectory,
            encoding: "utf-8",
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
            env: { ...process.env }
          });
          
          changes = parseGitDiff(diffOutput);
        } catch (gitError: any) {
          console.error(chalk.red(`❌ Git diff failed: ${gitError.message}`));
          console.error(chalk.red(`   Does the directory ${chalk.bold(sourceDirectory)} exist?`));
          throw gitError;
        }
      }

      console.log(chalk.cyan("📊 Changed translations:"));
      console.log(chalk.gray(JSON.stringify(changes, null, 2)));

      // Only proceed if there are changes
      if (Object.keys(changes).length === 0) {
        console.log(chalk.yellow("⚠️ No changes detected"));
        return;
      }

      // Split the changes into chunks
      const chunks = chunkObject(changes, chunkSize);

      // For each file, create a promise to call the AI assistant
      const jobs = outputFiles.map((file) => async () => {
        const prompt = createFinalPrompt(file);
        console.log(chalk.blue(`🔄 ${chalk.bold(file)}: creating ${chalk.bold(chunks.length.toString())} chunks`));
        // Call the AI assistant for each chunk
        const responses = await promiseAllLimited(
          PARALLEL_LIMIT,
          chunks.map((chunk, chunkIndex) => async () => {
            console.log(
              chalk.blue(`🤖 ${chalk.bold(file)}: calling AI assistant for chunk ${chalk.bold((chunkIndex + 1).toString())} of ${
                chalk.bold(chunks.length.toString())
              }`)
            );
            const aiResponse = await callTsAiAssistant({
              assistant_id: assistantId,
              content: `${prompt}\n\n${JSON.stringify(chunk)}`,
              client: aiClient,
            });

            console.log(
              chalk.green(`✅ ${chalk.bold(file)}: AI generated translations for chunk ${chalk.bold(
                (chunkIndex + 1).toString()
              )} of ${chalk.bold(chunks.length.toString())}`)
            );

            return JSON.parse(aiResponse);
          })
        );

        const merged = responses.reduce((acc, curr) => {
          return { ...acc, ...curr };
        }, {});

        console.log(chalk.green(`✅ ${chalk.bold(file)}: AI generated translations for all chunks`));

        return {
          [file]: merged,
        };
      });

      const results = await promiseAllLimited(parallelLimit, jobs);

      // Merge the results
      const translations = results.reduce<
        Record<string, Record<string, string>>
      >((acc, curr: any) => {
        return { ...acc, ...curr };
      }, {});

      console.log(chalk.cyan("📊 All translations generated successfully"));

      console.log(chalk.cyan("📈 Number of keys per file:"));
      outputFiles.forEach((file) => {
        console.log(chalk.blue(`   ${chalk.bold(file)}: ${chalk.bold(Object.keys(translations[file] || {}).length.toString())}`));
      });
      console.log(chalk.cyan(`📝 Original number of keys: ${chalk.bold(Object.keys(changes).length.toString())}`));

      // Define the files to update
      // Update each file
      for (const file of outputFiles) {
        const filePath = path.join(outputDirectory, file);

        try {
          // Read existing file or create empty object if doesn't exist
          let existingContent = {};
          try {
            existingContent = JSON.parse(
              fs.readFileSync(filePath, { encoding: "utf8" })
            );
          } catch (e) {
            console.log(chalk.blue(`📄 Creating new file: ${chalk.bold(file)}`));
          }

          // Merge new translations with existing content
          const updatedContent = {
            ...existingContent,
            ...(translations[file] || {}),
          };

          // Write back to file with explicit UTF-8 encoding
          fs.writeFileSync(filePath, JSON.stringify(updatedContent, null, 2), {
            encoding: "utf8",
          });

          console.log(chalk.green(`✅ Updated ${chalk.bold(file)} successfully`));
        } catch (error: any) {
          console.error(chalk.red(`❌ Error updating ${chalk.bold(file)}: ${error.message}`));
        }
      }
    } catch (error: any) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
    }
  };

  return run();
};
