export interface Heading {
  level: number;
  text: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/;
const TRAILING_CLOSING_HASHES = /[ \t]+#+[ \t]*$/;
const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;
const INDENT_4_PLUS = /^ {4}|^\t/;

function normalizeLineEndings(content: string): string[] {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function fenceMarker(line: string): "`" | "~" | null {
  const match = FENCE_START.exec(line);
  if (!match) return null;
  return match[1][0] === "`" ? "`" : "~";
}

export function parseHeadings(content: string): Heading[] {
  if (typeof content !== "string" || content.length === 0) {
    return [];
  }

  const lines = normalizeLineEndings(content);
  const headings: Heading[] = [];

  let inFrontmatter = false;
  let frontmatterDone = false;
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!frontmatterDone && i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      frontmatterDone = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") {
        inFrontmatter = false;
      }
      continue;
    }

    const marker = fenceMarker(line);
    if (marker) {
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (fenceChar === marker) {
        inFence = false;
        fenceChar = null;
      }
      continue;
    }

    if (inFence) continue;

    if (INDENT_4_PLUS.test(line)) continue;

    const match = ATX_HEADING.exec(line);
    if (!match) continue;

    const level = match[1].length;
    const text = match[2].replace(TRAILING_CLOSING_HASHES, "").trim();
    if (text.length > 0) {
      headings.push({ level, text });
    }
  }

  return headings;
}
