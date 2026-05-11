import type { FileIndex } from "./file-index";

export const FILES_INDEX_MARKER = "Files index:";
export const EMPTY_INDEX_SENTINEL = "(empty — no files indexed yet; ask the user to click Re-index)";
export const READ_FILE_GUIDANCE =
  "You have a tool `read_file(path)` that returns the full Markdown content of a file by its path from the index. " +
  "Use it when the index alone is not enough to answer.";

function formatHeadingLine(level: number, text: string): string {
  return `    ${"#".repeat(level)} ${text}`;
}

function formatFileBlock(filePath: string, headings: Array<{ level: number; text: string }>): string {
  const lines = [`- ${filePath}`];
  for (const heading of headings) {
    lines.push(formatHeadingLine(heading.level, heading.text));
  }
  return lines.join("\n");
}

export function formatSystemPromptBody(index: FileIndex | null): string {
  const sections: string[] = [FILES_INDEX_MARKER];

  if (!index || index.files.length === 0) {
    sections.push(EMPTY_INDEX_SENTINEL);
  } else {
    for (const file of index.files) {
      sections.push(formatFileBlock(file.path, file.headings));
    }
  }

  sections.push("");
  sections.push(READ_FILE_GUIDANCE);
  return sections.join("\n");
}
