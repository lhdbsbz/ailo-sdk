import { cpSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "src", "static");
const dst = join(__dirname, "dist", "static");

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });

console.log("[build] static files copied to dist/static/");
