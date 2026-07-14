import path from "node:path";

export const projectRoot = process.cwd();

export function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}
