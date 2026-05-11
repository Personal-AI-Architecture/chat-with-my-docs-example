declare const require: (id: string) => any;

const fs = require("fs") as {
  realpathSync(path: string): string;
};
const nodePath = require("path") as {
  isAbsolute(p: string): boolean;
  resolve(...parts: string[]): string;
  extname(p: string): string;
  sep: string;
};

export type PathSandboxErrorCode =
  | "invalid_path"
  | "out_of_sandbox"
  | "invalid_extension";

export class PathSandboxError extends Error {
  readonly code: PathSandboxErrorCode;
  constructor(code: PathSandboxErrorCode, message: string) {
    super(message);
    this.name = "PathSandboxError";
    this.code = code;
  }
}

export interface SandboxOptions {
  allowedExtensions?: string[];
}

const SAFE_MESSAGES: Record<PathSandboxErrorCode, string> = {
  invalid_path: "Requested path is not a valid resolvable path.",
  out_of_sandbox: "Requested path resolves outside the allowed root.",
  invalid_extension: "Requested path has a disallowed file extension."
};

function throwSandbox(code: PathSandboxErrorCode): never {
  throw new PathSandboxError(code, SAFE_MESSAGES[code]);
}

export function assertInSandbox(
  requested: unknown,
  root: unknown,
  options: SandboxOptions = {}
): string {
  if (typeof requested !== "string" || requested.length === 0) {
    throwSandbox("invalid_path");
  }
  if (typeof root !== "string" || root.length === 0) {
    throwSandbox("invalid_path");
  }
  if ((requested as string).indexOf("\0") !== -1) {
    throwSandbox("invalid_path");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(nodePath.resolve(root as string));
  } catch {
    throwSandbox("invalid_path");
  }

  const absoluteRequested = nodePath.isAbsolute(requested as string)
    ? nodePath.resolve(requested as string)
    : nodePath.resolve(canonicalRoot!, requested as string);

  const rootWithSep = canonicalRoot!.endsWith(nodePath.sep)
    ? canonicalRoot!
    : canonicalRoot! + nodePath.sep;

  if (absoluteRequested !== canonicalRoot! && !absoluteRequested.startsWith(rootWithSep)) {
    throwSandbox("out_of_sandbox");
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(absoluteRequested);
  } catch {
    throwSandbox("invalid_path");
  }

  if (canonical! !== canonicalRoot! && !canonical!.startsWith(rootWithSep)) {
    throwSandbox("out_of_sandbox");
  }

  if (options.allowedExtensions && options.allowedExtensions.length > 0) {
    const ext = nodePath.extname(canonical!).toLowerCase();
    const allowed = options.allowedExtensions.map((e) => e.toLowerCase());
    if (!allowed.includes(ext)) {
      throwSandbox("invalid_extension");
    }
  }

  return canonical!;
}
