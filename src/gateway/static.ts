declare const require: (id: string) => any;

const fsSync = require("fs") as {
  existsSync(p: string): boolean;
  realpathSync(p: string): string;
  promises: { readFile(p: string): Promise<Buffer> };
};
const fsp = fsSync.promises;
const nodePath = require("path") as {
  resolve(...parts: string[]): string;
  extname(p: string): string;
  sep: string;
};

export interface StaticAssetsConfig {
  web_root: string;
  index_file?: string;
}

export interface StaticAssetResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export interface StaticAssetsHandler {
  tryServe(method: string, urlPath: string): Promise<StaticAssetResponse | null>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};
const ALLOWED_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));

function notFound(): StaticAssetResponse {
  return {
    status: 404,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: { code: "not_found", message: "Asset not found." } })
  };
}

function isInsideRoot(canonical: string, canonicalRoot: string): boolean {
  if (canonical === canonicalRoot) return true;
  const rootWithSep = canonicalRoot.endsWith(nodePath.sep)
    ? canonicalRoot
    : canonicalRoot + nodePath.sep;
  return canonical.startsWith(rootWithSep);
}

export function createStaticAssetsHandler(config: StaticAssetsConfig): StaticAssetsHandler {
  if (!config || typeof config.web_root !== "string" || config.web_root.length === 0) {
    throw new Error("Static assets handler requires a web_root.");
  }
  const indexFile = config.index_file ?? "index.html";

  function resolveCanonicalRoot(): string | null {
    try {
      return fsSync.realpathSync(nodePath.resolve(config.web_root));
    } catch {
      return null;
    }
  }

  return {
    async tryServe(method: string, urlPath: string): Promise<StaticAssetResponse | null> {
      if (typeof method !== "string" || method.toUpperCase() !== "GET") return null;
      if (typeof urlPath !== "string") return null;

      const canonicalRoot = resolveCanonicalRoot();
      if (!canonicalRoot) return notFound();

      const cleanPath = urlPath.split("?")[0].split("#")[0];

      let decoded: string;
      try {
        decoded = decodeURIComponent(cleanPath);
      } catch {
        return notFound();
      }

      if (decoded.indexOf("\0") !== -1) return notFound();
      // After decoding, a still-encoded "%" suggests a double-encoded attack
      if (/%[0-9a-fA-F]{2}/.test(decoded)) {
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          return notFound();
        }
      }
      if (decoded.indexOf("\0") !== -1) return notFound();

      let relative: string;
      if (decoded === "" || decoded === "/") {
        relative = indexFile;
      } else {
        relative = decoded.replace(/^\/+/, "");
      }

      const absoluteRequested = nodePath.resolve(canonicalRoot, relative);
      if (!isInsideRoot(absoluteRequested, canonicalRoot)) return notFound();

      let canonical: string;
      try {
        canonical = fsSync.realpathSync(absoluteRequested);
      } catch {
        return notFound();
      }
      if (!isInsideRoot(canonical, canonicalRoot)) return notFound();

      const ext = nodePath.extname(canonical).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) return notFound();

      let content: Buffer;
      try {
        content = await fsp.readFile(canonical);
      } catch {
        return notFound();
      }

      return {
        status: 200,
        headers: {
          "Content-Type": CONTENT_TYPES[ext],
          "Cache-Control": "no-cache"
        },
        body: content
      };
    }
  };
}
