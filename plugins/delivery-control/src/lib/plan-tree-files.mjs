import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, join } from "node:path";
import { DEFAULT_BACKUP_RETENTION } from "../constants.mjs";
import { assertString, sha256 } from "./primitives.mjs";

export function contained(root, target) {
  const rootPath = resolve(assertString(root, "plan_root"));
  const targetPath = resolve(assertString(target, "plan_target"));
  const rel = relative(rootPath, targetPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { rootPath, targetPath };
  throw new Error("plan_target must be inside plan_root");
}

export const readText = (path) => readFileSync(path, "utf8");
export const fileDigest = (path) => sha256(readFileSync(path));

export function artifactPath(planRoot, artifact) {
  const value = assertString(artifact, "artifact");
  return isAbsolute(value) ? resolve(value) : resolve(planRoot, value);
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function atomicProject(target, content, transactionId) {
  const folder = dirname(target);
  const backupFolder = join(folder, ".delivery-control-backups");
  mkdirSync(backupFolder, { recursive: true });
  const temp = join(folder, `.${transactionId}.delivery-control.tmp`);
  const backup = join(backupFolder, `${basename(target)}.${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}.${transactionId}.bak`);
  copyFileSync(target, backup);
  const fd = openSync(temp, "wx");
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  syncDirectory(folder);
  syncDirectory(backupFolder);
  const backups = readdirSync(backupFolder)
    .filter((name) => name.startsWith(`${basename(target)}.`) && name.endsWith(".bak"))
    .map((name) => ({ path: join(backupFolder, name), mtime: statSync(join(backupFolder, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of backups.slice(DEFAULT_BACKUP_RETENTION)) {
    try { unlinkSync(stale.path); } catch {}
  }
  return { backup, temp };
}
