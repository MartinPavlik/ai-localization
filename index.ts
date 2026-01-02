import { promiseAllLimited } from "@satankebab/promise-all-limited";
import { execSync } from "child_process";
import fs from "fs";
import { OpenAI } from "openai";
import path from "path";
import chalk from "chalk";

const CHUNK_SIZE = 3000;
const PARALLEL_LIMIT = 10;


const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const extractWaitTimeFromError = (errorMessage: string): number | null => {
  // Try to extract wait time from messages like "Please try again in 1.362s"
  const match = errorMessage.match(/try again in ([\d.]+)s/i);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  return null;
};

const callTsAiAssistant = async ({ content, assistant_id, client, maxRetries = 5 }: {
  content: string;
  assistant_id: string;
  client: OpenAI;
  maxRetries?: number;
}) => {
  let retryCount = 0;
  
  while (retryCount <= maxRetries) {
    try {
      // Creates a thread and waits for the result
      const run = await client.beta.threads.createAndRunPoll({
        assistant_id,
        thread: {
          messages: [{ role: "user", content }],
        },
      });

      // 1) Never assume the run completed successfully
      if (run.status !== "completed") {
        // Pull full details (optional but helpful)
        const full = await client.beta.threads.runs.retrieve(run.thread_id, run.id);

        // Run steps are often the fastest way to see what happened
        const steps = await client.beta.threads.runs.steps.list(run.thread_id, run.id);

        const errorMessage = `Run not completed. status=${full.status} ` +
          `last_error=${JSON.stringify(full.last_error)} ` +
          `incomplete_details=${JSON.stringify(full.incomplete_details)} ` +
          `steps_count=${steps.data?.length ?? 0}`;

        // Check if this is a rate limit error
        if (full.last_error?.code === "rate_limit_exceeded" && retryCount < maxRetries) {
          const message = full.last_error.message || "";
          const waitTime = extractWaitTimeFromError(message);
          
          // Calculate wait time: use extracted time + buffer, or exponential backoff
          const baseWait = waitTime ? waitTime * 1000 : Math.pow(2, retryCount) * 1000;
          const bufferTime = 500; // Add 500ms buffer
          const totalWaitMs = baseWait + bufferTime;
          
          retryCount++;
          console.log(chalk.yellow(`⏳ Rate limit exceeded. Waiting ${(totalWaitMs / 1000).toFixed(1)}s before retry (attempt ${retryCount}/${maxRetries})...`));
          console.log(chalk.gray(`   ${message}`));
          
          await sleep(totalWaitMs);
          continue; // Retry the request
        }

        throw new Error(errorMessage);
      }

      // 2) List messages produced by THIS run, then pick the assistant message
      const msgs = await client.beta.threads.messages.list(run.thread_id, {
        run_id: run.id,
        order: "desc",
        limit: 20,
      });

      const assistantMsg = msgs.data.find(m => m.role === "assistant");
      if (!assistantMsg) {
        throw new Error(`Run completed but no assistant message found for run_id=${run.id}`);
      }

      // 3) Extract text content safely
      const textParts = assistantMsg.content
        .filter(p => p.type === "text")
        .map(p => p.type === "text" ? (p.text?.value ?? "") : "");

      return textParts.join("\n").trim();
    } catch (error: any) {
      // Check if this is a rate limit error from the API call itself (not from run status)
      if (error.message?.includes("rate_limit") && retryCount < maxRetries) {
        const waitTime = extractWaitTimeFromError(error.message);
        const baseWait = waitTime ? waitTime * 1000 : Math.pow(2, retryCount) * 1000;
        const bufferTime = 500;
        const totalWaitMs = baseWait + bufferTime;
        
        retryCount++;
        console.log(chalk.yellow(`⏳ Rate limit exceeded. Waiting ${(totalWaitMs / 1000).toFixed(1)}s before retry (attempt ${retryCount}/${maxRetries})...`));
        console.log(chalk.gray(`   ${error.message}`));
        
        await sleep(totalWaitMs);
        continue; // Retry the request
      }
      
      // If not a rate limit error or max retries exceeded, throw the error
      throw error;
    }
  }
  
  throw new Error(`Max retries (${maxRetries}) exceeded due to rate limiting`);
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

type TranslationError = {
  file: string;
  chunkIndex: number;
  totalChunks: number;
  error: string;
  sentToApi: {
    prompt: string;
    chunk: Record<string, unknown>;
  };
  receivedFromApi?: string;
  rawError?: unknown;
};

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
  const errors: TranslationError[] = [];

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
      // Read the source file
      const sourcePath = path.join(sourceDirectory, sourceFile);
      console.log(chalk.blue(`📖 Reading source file: ${chalk.bold(sourcePath)}`));
      
      let sourceContent: Record<string, string>;
      try {
        sourceContent = JSON.parse(fs.readFileSync(sourcePath, { encoding: "utf8" }));
      } catch (error: any) {
        console.error(chalk.red(`❌ Failed to read source file: ${error.message}`));
        throw error;
      }

      console.log(chalk.cyan(`📊 Source file contains ${chalk.bold(Object.keys(sourceContent).length.toString())} keys`));

      // Get changed keys from git diff (if not in recreate mode)
      let changedKeysFromGit: Set<string> = new Set();
      
      if (!recreate) {
        try {
          const diffCommand = `git diff ${sourcePath}`;
          console.log(chalk.gray(`🔍 Executing: ${chalk.italic(diffCommand)}`));
          console.log(chalk.gray(`📂 Working directory: ${chalk.italic(sourceDirectory)}`));
          
          const diffOutput = execSync(diffCommand, {
            cwd: sourceDirectory,
            encoding: "utf-8",
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
            env: { ...process.env }
          });
          
          const gitChanges = parseGitDiff(diffOutput);
          changedKeysFromGit = new Set(Object.keys(gitChanges));
          
          if (changedKeysFromGit.size > 0) {
            console.log(chalk.cyan(`🔄 Git diff detected ${chalk.bold(changedKeysFromGit.size.toString())} changed keys`));
          } else {
            console.log(chalk.gray(`ℹ️  No changes detected in git diff`));
          }
        } catch (gitError: any) {
          console.log(chalk.yellow(`⚠️  Git diff failed or not available: ${gitError.message}`));
          console.log(chalk.yellow(`   Will only translate missing keys based on file comparison`));
        }
      }

      // For each file, create a promise to call the AI assistant
      const jobs = outputFiles.map((file) => async () => {
        const targetPath = path.join(outputDirectory, file);
        
        // Determine what keys need to be translated for this specific file
        let keysToTranslate: Record<string, string>;
        
        if (recreate) {
          // If recreate flag is set, translate all keys from source
          console.log(chalk.blue(`🔄 ${chalk.bold(file)}: Recreate mode - translating all ${chalk.bold(Object.keys(sourceContent).length.toString())} keys`));
          keysToTranslate = sourceContent;
        } else {
          // Compare source and target to find missing keys
          let targetContent: Record<string, string>;
          try {
            targetContent = JSON.parse(fs.readFileSync(targetPath, { encoding: "utf8" }));
            console.log(chalk.gray(`📖 ${chalk.bold(file)}: Loaded existing file with ${chalk.bold(Object.keys(targetContent).length.toString())} keys`));
          } catch (e: any) {
            throw new Error(`Target file not found: ${targetPath}. Please create the file before running translations, or use recreate: true to generate it from scratch.`);
          }
          
          // Find keys that need to be translated:
          // 1. Keys that changed in git diff (changedKeysFromGit)
          // 2. Keys that are in source but not in target (missing keys)
          const keysToTranslateSet = new Set<string>();
          
          // Add all changed keys from git diff
          changedKeysFromGit.forEach(key => {
            if (key in sourceContent) {
              keysToTranslateSet.add(key);
            }
          });
          
          // Add all missing keys (in source but not in target)
          Object.keys(sourceContent).forEach(key => {
            if (!(key in targetContent)) {
              keysToTranslateSet.add(key);
            }
          });
          
          // Build the object with keys to translate
          keysToTranslate = Array.from(keysToTranslateSet).reduce((acc, key) => {
            acc[key] = sourceContent[key];
            return acc;
          }, {} as Record<string, string>);
          
          const totalCount = keysToTranslateSet.size;
          const changedCount = Array.from(changedKeysFromGit).filter(k => k in sourceContent).length;
          const missingCount = Object.keys(sourceContent).filter(k => !(k in targetContent)).length;
          
          if (totalCount === 0) {
            console.log(chalk.green(`✅ ${chalk.bold(file)}: Already up to date, no keys to translate`));
            return { [file]: {} };
          }
          
          console.log(chalk.yellow(`🔄 ${chalk.bold(file)}: Found ${chalk.bold(totalCount.toString())} keys to translate (${chalk.bold(changedCount.toString())} changed, ${chalk.bold(missingCount.toString())} missing)`));
        }
        
        // Split the keys to translate into chunks
        const chunks = chunkObject(keysToTranslate, chunkSize);
        
        const prompt = createFinalPrompt(file);
        console.log(chalk.blue(`🔄 ${chalk.bold(file)}: creating ${chalk.bold(chunks.length.toString())} chunks`));
        // Call the AI assistant for each chunk
        const responses = await promiseAllLimited(
          parallelLimit,
          chunks.map((chunk, chunkIndex) => async () => {
            console.log(
              chalk.blue(`🤖 ${chalk.bold(file)}: calling AI assistant for chunk ${chalk.bold((chunkIndex + 1).toString())} of ${
                chalk.bold(chunks.length.toString())
              }`)
            );
            
            try {
              const content = `${prompt}\n\n${JSON.stringify(chunk)}`;
              const aiResponse = await callTsAiAssistant({
                assistant_id: assistantId,
                content,
                client: aiClient,
              });

              console.log(
                chalk.green(`✅ ${chalk.bold(file)}: AI generated translations for chunk ${chalk.bold(
                  (chunkIndex + 1).toString()
                )} of ${chalk.bold(chunks.length.toString())}`)
              );

              try {
                return JSON.parse(aiResponse);
              } catch (parseError) {
                // Failed to parse JSON response
                console.error(
                  chalk.red(`❌ ${chalk.bold(file)}: Failed to parse JSON for chunk ${chalk.bold(
                    (chunkIndex + 1).toString()
                  )} - continuing with other chunks`)
                );
                
                errors.push({
                  file,
                  chunkIndex: chunkIndex + 1,
                  totalChunks: chunks.length,
                  error: 'Failed to parse JSON response',
                  sentToApi: { prompt, chunk },
                  receivedFromApi: aiResponse,
                  rawError: parseError,
                });
                
                return null;
              }
            } catch (apiError) {
              // API call failed
              console.error(
                chalk.red(`❌ ${chalk.bold(file)}: API call failed for chunk ${chalk.bold(
                  (chunkIndex + 1).toString()
                )} - continuing with other chunks`)
              );
              
              errors.push({
                file,
                chunkIndex: chunkIndex + 1,
                totalChunks: chunks.length,
                error: 'API call failed',
                sentToApi: { prompt, chunk },
                rawError: apiError,
              });
              
              return null;
            }
          })
        );

        // Filter out null responses from failed chunks
        const validResponses = responses.filter((response) => response !== null);

        const merged = validResponses.reduce((acc, curr) => {
          return { ...acc, ...curr };
        }, {});

        const successfulChunks = validResponses.length;
        if (successfulChunks < chunks.length) {
          console.log(chalk.yellow(`⚠️ ${chalk.bold(file)}: Processed ${chalk.bold(successfulChunks.toString())} of ${chalk.bold(chunks.length.toString())} chunks successfully`));
        } else {
          console.log(chalk.green(`✅ ${chalk.bold(file)}: AI generated translations for all chunks`));
        }

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

      console.log(chalk.cyan("📈 Number of translated keys per file:"));
      outputFiles.forEach((file) => {
        const translatedCount = Object.keys(translations[file] || {}).length;
        console.log(chalk.blue(`   ${chalk.bold(file)}: ${chalk.bold(translatedCount.toString())} new keys translated`));
      });

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
      
      // Log all errors at the end
      if (errors.length > 0) {
        console.log('\n');
        console.log(chalk.red('═══════════════════════════════════════════════════════════'));
        console.log(chalk.red.bold(`❌ TRANSLATION ERRORS SUMMARY (${errors.length} total)`));
        console.log(chalk.red('═══════════════════════════════════════════════════════════'));
        
        errors.forEach((error, index) => {
          console.log('\n');
          console.log(chalk.red(`─────────────── Error ${index + 1} of ${errors.length} ───────────────`));
          console.log(chalk.yellow(`📁 File: ${chalk.bold(error.file)}`));
          console.log(chalk.yellow(`📦 Chunk: ${chalk.bold(error.chunkIndex.toString())} of ${chalk.bold(error.totalChunks.toString())}`));
          console.log(chalk.yellow(`❗ Error: ${chalk.bold(error.error)}`));
          
          console.log('\n' + chalk.cyan('📤 Sent to API:'));
          console.log(chalk.gray('Prompt:'));
          console.log(chalk.gray(error.sentToApi.prompt.substring(0, 200) + (error.sentToApi.prompt.length > 200 ? '...' : '')));
          console.log(chalk.gray('\nChunk data:'));
          console.log(chalk.gray(JSON.stringify(error.sentToApi.chunk, null, 2)));
          
          if (error.receivedFromApi) {
            console.log('\n' + chalk.cyan('📥 Received from API:'));
            console.log(chalk.gray(error.receivedFromApi.substring(0, 500) + (error.receivedFromApi.length > 500 ? '...' : '')));
          } else {
            console.log('\n' + chalk.cyan('📥 Received from API:'));
            console.log(chalk.gray('(No response received)'));
          }
          
          if (error.rawError) {
            console.log('\n' + chalk.cyan('🔍 Raw Error Details:'));
            console.log(chalk.gray(error.rawError instanceof Error ? error.rawError.message : String(error.rawError)));
            if (error.rawError instanceof Error && error.rawError.stack) {
              console.log(chalk.gray('Stack trace:'));
              console.log(chalk.gray(error.rawError.stack));
            }
          }
        });
        
        console.log('\n');
        console.log(chalk.red('═══════════════════════════════════════════════════════════'));
      } else {
        console.log('\n');
        console.log(chalk.green('✅ All translations completed successfully with no errors!'));
      }
    } catch (error: any) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
    }
  };

  return run();
};
