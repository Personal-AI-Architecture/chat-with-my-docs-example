declare const require: (id: string) => any;

const fs = require("fs") as {
  promises: {
    readdir(
      path: string,
      options: { withFileTypes: true }
    ): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>>;
    readFile(path: string): Promise<Buffer>;
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  };
};
const fsp = fs.promises;
const nodePath = require("path") as {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  sep: string;
  posix: { join(...parts: string[]): string };
};

import { parseHeadings, type Heading } from "./markdown-toc";

export type FileIndexErrorCode = "folder_missing" | "not_a_directory";

export class FileIndexError extends Error {
  readonly code: FileIndexErrorCode;
  constructor(code: FileIndexErrorCode, message: string) {
    super(message);
    this.name = "FileIndexError";
    this.code = code;
  }
}

export interface IndexedFile {
  path: string;
  headings: Heading[];
}

export interface FileIndex {
  files: IndexedFile[];
}

const MAX_READ_BYTES = 1024 * 1024;

function isInsideRoot(canonical: string, canonicalRoot: string): boolean {
  if (canonical === canonicalRoot) return true;
  const rootWithSep = canonicalRoot.endsWith(nodePath.sep)
    ? canonicalRoot
    : canonicalRoot + nodePath.sep;
  return canonical.startsWith(rootWithSep);
}

function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

async function indexFile(absolutePath: string, relativePath: string, out: IndexedFile[]): Promise<void> {
  let content: string;
  try {
    const buf = await fsp.readFile(absolutePath);
    content =
      buf.length > MAX_READ_BYTES
        ? buf.slice(0, MAX_READ_BYTES).toString("utf8")
        : buf.toString("utf8");
  } catch {
    return;
  }
  out.push({ path: relativePath, headings: parseHeadings(content) });
}

async function scan(
  absoluteDir: string,
  relativeDir: string,
  canonicalRoot: string,
  out: IndexedFile[]
): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const absChild = nodePath.join(absoluteDir, entry.name);
    const relChild = relativeDir
      ? nodePath.posix.join(relativeDir, entry.name)
      : entry.name;

    if (entry.isSymbolicLink()) {
      let canonicalChild: string;
      try {
        canonicalChild = await fsp.realpath(absChild);
      } catch {
        continue;
      }
      if (!isInsideRoot(canonicalChild, canonicalRoot)) continue;

      let stat;
      try {
        stat = await fsp.stat(canonicalChild);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await scan(canonicalChild, relChild, canonicalRoot, out);
      } else if (stat.isFile() && isMarkdownName(entry.name)) {
        await indexFile(canonicalChild, relChild, out);
      }
      continue;
    }

    if (entry.isDirectory()) {
      await scan(absChild, relChild, canonicalRoot, out);
      continue;
    }

    if (entry.isFile() && isMarkdownName(entry.name)) {
      await indexFile(absChild, relChild, out);
    }
  }
}

export async function buildIndex(folder: unknown): Promise<FileIndex> {
  if (typeof folder !== "string" || folder.length === 0) {
    throw new FileIndexError("folder_missing", "Folder path is not a valid string.");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await fsp.realpath(nodePath.resolve(folder));
  } catch {
    throw new FileIndexError("folder_missing", "Folder does not exist or cannot be resolved.");
  }

  let stat;
  try {
    stat = await fsp.stat(canonicalRoot);
  } catch {
    throw new FileIndexError("folder_missing", "Folder does not exist.");
  }

  if (!stat.isDirectory()) {
    throw new FileIndexError("not_a_directory", "Path exists but is not a directory.");
  }

  const files: IndexedFile[] = [];
  await scan(canonicalRoot, "", canonicalRoot, files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}
