const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "console.html");
const dest = path.join(__dirname, "..", "dist", "console.html");

fs.copyFileSync(src, dest);
console.log("Copied console.html to dist/");
