#!/usr/bin/env node
/**
 * Manual end-to-end demo: indexes the configured notes folder, then runs
 * one chat turn against a local Ollama and prints the streamed response.
 *
 * Prerequisites:
 *   - ollama serve running on http://localhost:11434
 *   - the model in config/runtime.json (default: qwen2.5:7b) pulled:
 *       ollama pull qwen2.5:7b
 *   - a folder of Markdown files at the path in config/runtime.json
 *       (default: ~/Desktop/BrainDrive Files)
 *
 * Usage:
 *   node scripts/demo-chat.js "What does my note about X say?"
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installTypeScriptRequire } = require('./ts-require.js');

const INDEX_KEY = 'library/index';

function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadRuntimeConfig() {
  const configPath = path.join(__dirname, '..', 'config', 'runtime.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.memory_root = expandHome(parsed.memory_root);
  parsed.library = parsed.library ?? {};
  parsed.library.notes_folder = expandHome(parsed.library.notes_folder);
  return parsed;
}

function approveIndexWrites() {
  return (request) => {
    if (request.metadata && request.metadata.key === INDEX_KEY) {
      return { approved: true, reason: 'Auto-approved: library index write.' };
    }
    return false;
  };
}

async function runDemoChat() {
  const restore = installTypeScriptRequire();
  try {
    const { createMemoryTools } = require('../src/memory/tools.ts');
    const { createGatewayConversationStore } = require('../src/gateway/conversation-store.ts');
    const { createGatewayRoutes } = require('../src/gateway/routes.ts');
    const { createEngineChatHandler } = require('../src/engine/index.ts');
    const { createToolExecutor } = require('../src/engine/tool-executor.ts');
    const { createOpenAICompatibleAdapter } = require('../src/adapters/openai-compatible.ts');
    const { buildIndex } = require('../src/library/file-index.ts');
    const { formatSystemPromptBody } = require('../src/library/system-prompt-format.ts');
    const {
      createReadFileToolDefinition,
      createReadFileHandler,
      READ_FILE_TOOL_NAME,
      READ_FILE_SOURCE
    } = require('../src/tools/read-file.ts');

    const runtime = loadRuntimeConfig();
    const userQuery = process.argv[2] || 'Briefly tell me what files you have access to.';
    const notesFolder = runtime.library.notes_folder;

    if (!fs.existsSync(notesFolder)) {
      console.error(`Notes folder not found: ${notesFolder}`);
      console.error('Create the folder and add some .md files, or edit config/runtime.json.');
      process.exitCode = 1;
      return;
    }

    fs.mkdirSync(runtime.memory_root, { recursive: true });

    const memoryTools = await createMemoryTools({
      memory_root: runtime.memory_root,
      approvals: { decide: approveIndexWrites() }
    });

    console.log(`[demo] indexing: ${notesFolder}`);
    const index = await buildIndex(notesFolder);
    await memoryTools.write(INDEX_KEY, index);
    console.log(`[demo] indexed files: ${index.files.length}`);

    const toolDef = createReadFileToolDefinition();
    const toolExecutor = createToolExecutor({
      tools: [toolDef],
      handlers: {
        [READ_FILE_TOOL_NAME]: createReadFileHandler({ sandbox_root: notesFolder })
      },
      allowed_tool_sources: [READ_FILE_SOURCE]
    });

    const adapter = createOpenAICompatibleAdapter({
      api_base_url: runtime.adapter.api_base_url,
      model: runtime.adapter.model
    });

    const engineHandler = createEngineChatHandler({
      model_adapter: adapter,
      tools: [toolDef],
      tool_executor: toolExecutor,
      allowed_tool_sources: [READ_FILE_SOURCE]
    });

    const systemPromptBuilder = {
      async build() {
        const stored = await memoryTools.read(INDEX_KEY);
        return {
          role: 'system',
          content: formatSystemPromptBody(stored ? stored.value : null)
        };
      }
    };

    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: engineHandler,
      system_prompt_builder: systemPromptBuilder
    });

    console.log(`\n[demo] user: ${userQuery}\n[demo] assistant:`);

    const response = await routes.handle({
      method: 'POST',
      path: '/chat',
      headers: {
        'X-Actor-ID': 'local-owner',
        'X-Actor-Permissions': 'read_file,memory.read,memory.write'
      },
      body: {
        content: userQuery,
        metadata: { channel: 'demo-chat' }
      }
    });

    if (response.status !== 200 || !response.stream) {
      console.error('[demo] non-streaming response:', response.status, response.body);
      process.exitCode = 1;
      return;
    }

    let saw = '';
    for await (const event of response.stream) {
      if (event.event === 'text-delta') {
        const text = event.data && typeof event.data.text === 'string' ? event.data.text : '';
        process.stdout.write(text);
        saw += text;
      } else if (event.event === 'tool-call') {
        process.stdout.write(`\n[tool-call ${event.data?.name}(${event.data?.arguments})]\n`);
      } else if (event.event === 'tool-result') {
        const out = typeof event.data?.output === 'string' ? event.data.output : '';
        process.stdout.write(`\n[tool-result ${out.length} chars]\n`);
      } else if (event.event === 'error') {
        process.stdout.write(`\n[error ${event.data?.code} ${event.data?.message ?? ''}]\n`);
      } else if (event.event === 'done') {
        process.stdout.write(`\n[done]\n`);
      }
    }
    if (saw.length === 0) {
      console.log('\n[demo] no text streamed — check Ollama is running and the model is pulled.');
    }
  } finally {
    restore();
  }
}

if (require.main === module) {
  runDemoChat().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runDemoChat };
