/**
 * Copies src/static → dist/static for packages that ship a static UI.
 * Run from the package directory (npm sets cwd to the workspace package).
 */
import { cpSync, mkdirSync } from "fs";
import { join } from "path";

const cwd = process.cwd();
const src = join(cwd, "src", "static");
const dst = join(cwd, "dist", "static");
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("[build] static files copied to dist/static/");
