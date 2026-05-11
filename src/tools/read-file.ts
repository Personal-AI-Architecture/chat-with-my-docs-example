declare const require: (id: string) => any;

const fs = require("fs") as {
  promises: { readFile(p: string): Promise<Buffer> };
};
const fsp = fs.promises;

import { type ToolDefinition } from "../types/contracts";
import { type ToolHandler } from "../engine/tool-executor";
import { assertInSandbox, PathSandboxError } from "../library/path-sandbox";

export const READ_FILE_TOOL_NAME = "read_file";
export const READ_FILE_SOURCE = "library";
export const READ_FILE_PERMISSION = "read_file";
export const READ_FILE_MAX_BYTES = 64 * 1024;
export const READ_FILE_TRUNCATION_MARKER =
  "\n\n[... truncated: file exceeds the 64 KiB cap; ask for a more specific question to drill in ...]";

export interface ReadFileConfig {
  sandbox_root: string;
}

interface ReadFileInput {
  path?: unknown;
}

export function createReadFileToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: READ_FILE_TOOL_NAME,
      description:
        "Read the contents of a Markdown file from the user's notes folder. Use this when the file index alone is not enough to answer a question grounded in the user's notes. The path must be a Markdown file inside the configured notes folder.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path of the Markdown file. Relative paths are resolved against the notes folder (e.g. 'sub/note.md')."
          }
        },
        required: ["path"],
        additionalProperties: false
      }
    },
    source: READ_FILE_SOURCE,
    mutates_state: false,
    required_permissions: [READ_FILE_PERMISSION]
  };
}

export function createReadFileHandler(config: ReadFileConfig): ToolHandler {
  if (!config || typeof config.sandbox_root !== "string" || config.sandbox_root.length === 0) {
    throw new Error("read_file_handler_requires_sandbox_root");
  }
  const root = config.sandbox_root;

  return async (input: unknown): Promise<string> => {
    const requested = (input as ReadFileInput | null | undefined)?.path;
    if (typeof requested !== "string" || requested.length === 0) {
      throw new Error("read_file_invalid_argument");
    }

    let canonical: string;
    try {
      canonical = assertInSandbox(requested, root, { allowedExtensions: [".md"] });
    } catch (err) {
      if (err instanceof PathSandboxError) {
        throw new Error(`read_file_${err.code}`);
      }
      throw new Error("read_file_invalid_path");
    }

    let buf: Buffer;
    try {
      buf = await fsp.readFile(canonical);
    } catch {
      throw new Error("read_file_read_failed");
    }

    if (buf.length > READ_FILE_MAX_BYTES) {
      return buf.slice(0, READ_FILE_MAX_BYTES).toString("utf8") + READ_FILE_TRUNCATION_MARKER;
    }
    return buf.toString("utf8");
  };
}
