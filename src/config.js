import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const configPath = path.join(projectRoot, "config.json");

export function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error("Missing config.json. Copy config-example.json to config.json and fill in Tower credentials.");
  }

  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

export function getProjectRoot() {
  return projectRoot;
}
