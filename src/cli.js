#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { loadConfig } from "./config.js";
import { getProjectRoot } from "./config.js";
import { TowerClient } from "./tower-client.js";

function printUsage() {
  console.log(`Usage:
  node src/cli.js launch <templateKey> [key=value ...]
  node src/cli.js status <jobId>
  node src/cli.js logs <jobId>
  node src/cli.js watch <jobId>
  node src/cli.js install-tools <computerName> [toolName ...]
`);
}

function normalizeKey(key) {
  return key.replace(/[-_]/g, "").toLowerCase();
}

function resolveTemplate(config, templateKey) {
  const normalizedInput = normalizeKey(templateKey);
  const matchedKey = Object.keys(config.templates).find(
    (k) => normalizeKey(k) === normalizedInput
  );

  if (!matchedKey) {
    const availableTemplates = Object.keys(config.templates).join(", ");
    throw new Error(
      `Unknown template key: ${templateKey}. Available templates: ${availableTemplates}`
    );
  }

  return config.templates[matchedKey];
}

function parseValue(rawValue) {
  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  if (/^-?\d+$/.test(rawValue)) {
    return Number(rawValue);
  }

  return rawValue;
}

function getToolsDirectory() {
  return path.join(getProjectRoot(), "tools");
}

function getStateFilePath() {
  return path.join(getProjectRoot(), ".tower-state.json");
}

function loadState() {
  const stateFilePath = getStateFilePath();

  if (!fs.existsSync(stateFilePath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(getStateFilePath(), JSON.stringify(state, null, 2));
}

function parseDeploymentArtifacts(job) {
  const exportArtifacts = job?.artifacts?.JENKINS_EXPORT;

  if (!Array.isArray(exportArtifacts)) {
    return null;
  }

  const deploymentInfo = {};

  for (const artifactEntry of exportArtifacts) {
    if (!artifactEntry || typeof artifactEntry !== "object") {
      continue;
    }

    if (artifactEntry.hostname) {
      deploymentInfo.hostname = artifactEntry.hostname;
    }

    if (artifactEntry.fqdn) {
      deploymentInfo.fqdn = artifactEntry.fqdn;
    }

    if (artifactEntry.ip) {
      deploymentInfo.ip = artifactEntry.ip;
    }
  }

  if (!deploymentInfo.hostname && !deploymentInfo.fqdn && !deploymentInfo.ip) {
    return null;
  }

  return deploymentInfo;
}

function formatDeploymentInfo(deploymentInfo) {
  if (!deploymentInfo) {
    return [];
  }

  return [
    deploymentInfo.hostname ? `Hostname: ${deploymentInfo.hostname}` : null,
    deploymentInfo.fqdn ? `FQDN: ${deploymentInfo.fqdn}` : null,
    deploymentInfo.ip ? `IP: ${deploymentInfo.ip}` : null,
  ].filter(Boolean);
}

function persistDeploymentInfo(job) {
  const deploymentInfo = parseDeploymentArtifacts(job);

  if (!deploymentInfo) {
    return null;
  }

  const currentState = loadState();
  saveState({
    ...currentState,
    lastDeployment: {
      jobId: job.id,
      name: job.name,
      ...deploymentInfo,
      updatedAt: new Date().toISOString(),
    },
  });

  return deploymentInfo;
}

function getDeploymentTargetFromState() {
  const lastDeployment = loadState().lastDeployment;

  if (!lastDeployment) {
    return null;
  }

  return lastDeployment.fqdn || lastDeployment.hostname || lastDeployment.ip || null;
}

function listToolFiles() {
  const toolsDirectory = getToolsDirectory();

  if (!fs.existsSync(toolsDirectory)) {
    throw new Error(`Tools directory not found: ${toolsDirectory}`);
  }

  return fs
    .readdirSync(toolsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      filePath: path.join(toolsDirectory, entry.name),
    }));
}

function resolveToolFiles(requestedToolNames) {
  const availableToolFiles = listToolFiles();

  if (availableToolFiles.length === 0) {
    throw new Error(`No files found in tools directory: ${getToolsDirectory()}`);
  }

  if (requestedToolNames.length === 0) {
    return availableToolFiles;
  }

  return requestedToolNames.map((requestedToolName) => {
    const normalizedRequestedToolName = normalizeKey(requestedToolName);
    const matchedTool = availableToolFiles.find((toolFile) => {
      const baseName = path.parse(toolFile.name).name;
      return (
        normalizeKey(toolFile.name) === normalizedRequestedToolName ||
        normalizeKey(baseName) === normalizedRequestedToolName
      );
    });

    if (!matchedTool) {
      const availableTools = availableToolFiles.map((toolFile) => toolFile.name).join(", ");
      throw new Error(
        `Unknown tool '${requestedToolName}'. Available tools: ${availableTools}`
      );
    }

    return matchedTool;
  });
}

function getWindowsRemoteConfig(config) {
  const windowsRemoteConfig = config.windowsRemote || {};
  const username = process.env.WINDOWS_VM_USERNAME || windowsRemoteConfig.username;
  const password = process.env.WINDOWS_VM_PASSWORD || windowsRemoteConfig.password;

  if (!username || !password) {
    throw new Error(
      "Missing Windows remote credentials. Set windowsRemote.username and windowsRemote.password in config.json or provide WINDOWS_VM_USERNAME and WINDOWS_VM_PASSWORD environment variables."
    );
  }

  return {
    username,
    password,
    port:
      process.env.WINDOWS_VM_PORT !== undefined
        ? Number(process.env.WINDOWS_VM_PORT)
        : windowsRemoteConfig.port,
    useSsl:
      process.env.WINDOWS_VM_USE_SSL !== undefined
        ? process.env.WINDOWS_VM_USE_SSL === "true"
        : Boolean(windowsRemoteConfig.useSsl),
    skipCertificateCheck:
      process.env.WINDOWS_VM_SKIP_CERT_CHECK !== undefined
        ? process.env.WINDOWS_VM_SKIP_CERT_CHECK === "true"
        : Boolean(windowsRemoteConfig.skipCertificateCheck),
    destinationRoot:
      process.env.WINDOWS_VM_DESTINATION_ROOT ||
      windowsRemoteConfig.destinationRoot ||
      "C:\\Tools",
  };
}

async function installToolsOnWindows(computerName, requestedToolNames, config) {
  const toolFiles = resolveToolFiles(requestedToolNames);
  const windowsRemoteConfig = getWindowsRemoteConfig(config);
  const powershellExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const scriptPath = path.join(getProjectRoot(), "src", "install-tools.ps1");
  const powershellArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ComputerName",
    computerName,
    "-Username",
    windowsRemoteConfig.username,
    "-Password",
    windowsRemoteConfig.password,
    "-DestinationRoot",
    windowsRemoteConfig.destinationRoot,
    "-ToolPathsJson",
    JSON.stringify(toolFiles.map((toolFile) => toolFile.filePath)),
  ];

  if (windowsRemoteConfig.port !== undefined && !Number.isNaN(windowsRemoteConfig.port)) {
    powershellArgs.push("-Port", String(windowsRemoteConfig.port));
  }

  if (windowsRemoteConfig.useSsl) {
    powershellArgs.push("-UseSsl");
  }

  if (windowsRemoteConfig.skipCertificateCheck) {
    powershellArgs.push("-SkipCertificateCheck");
  }

  console.log(`Installing ${toolFiles.length} tool(s) on ${computerName}...`);

  await new Promise((resolve, reject) => {
    const childProcess = spawn(powershellExecutable, powershellArgs, {
      stdio: "inherit",
    });

    childProcess.on("error", reject);
    childProcess.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Tool installation failed with exit code ${code}.`));
    });
  });
}

function parseExtraVarArgs(args, forceStringKeys = new Set()) {
  const extraVars = {};

  for (const arg of args) {
    const separatorIndex = arg.indexOf("=");

    if (separatorIndex === -1) {
      throw new Error(
        `Invalid parameter '${arg}'. Expected key=value format.`
      );
    }

    const key = arg.slice(0, separatorIndex).trim();
    const rawValue = arg.slice(separatorIndex + 1).trim();

    if (!key) {
      throw new Error(`Invalid parameter '${arg}'. Parameter name is empty.`);
    }

    extraVars[key] = forceStringKeys.has(key) ? rawValue : parseValue(rawValue);
  }

  return extraVars;
}

function validateRequiredParameters(templateKey, template, extraVars) {
  const requiredParameters = template.requiredParameters || [];
  const missingParameters = requiredParameters.filter(
    (parameter) => extraVars[parameter.key] === undefined
  );

  if (missingParameters.length === 0) {
    return;
  }

  const missingList = missingParameters
    .map((parameter) => `${parameter.label} (${parameter.key})`)
    .join(", ");

  throw new Error(
    `Missing required parameters for template '${templateKey}': ${missingList}`
  );
}

function validateAllowedParameterValues(templateKey, template, extraVars) {
  const parametersWithAllowedValues = (template.requiredParameters || []).filter(
    (parameter) => Array.isArray(parameter.allowedValues)
  );

  for (const parameter of parametersWithAllowedValues) {
    const value = extraVars[parameter.key];

    if (value === undefined) {
      continue;
    }

    if (!parameter.allowedValues.includes(value)) {
      const allowedValues = parameter.allowedValues.join(", ");
      throw new Error(
        `Invalid value for ${parameter.label} (${parameter.key}) on template '${templateKey}': ${value}. Allowed values: ${allowedValues}`
      );
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatJob(job) {
  return [
    `Job ID: ${job.id}`,
    `Name: ${job.name}`,
    `Status: ${job.status}`,
    `Created: ${job.created}`,
    `Started: ${job.started || "N/A"}`,
    `Finished: ${job.finished || "In Progress"}`,
    `Elapsed: ${job.elapsed} seconds`,
    `Failed Tasks: ${job.failed_tasks || 0}`,
    ...formatDeploymentInfo(parseDeploymentArtifacts(job)),
  ].join("\n");
}

async function main() {
  const [command, arg1, ...restArgs] = process.argv.slice(2);

  if (!command) {
    printUsage();
    process.exit(1);
  }

  const config = loadConfig();
  const towerClient = new TowerClient(config);

  if (command === "launch") {
    if (!arg1) {
      throw new Error("Missing templateKey for launch command.");
    }

    const template = resolveTemplate(config, arg1);
    const forceStringKeys = new Set(
      (template.requiredParameters || [])
        .filter((p) => p.forceString)
        .map((p) => p.key)
    );
    const cliExtraVars = parseExtraVarArgs(restArgs, forceStringKeys);
    const mergedExtraVars = {
      ...(template.extraVars || {}),
      ...cliExtraVars,
    };

    validateRequiredParameters(arg1, template, mergedExtraVars);
    validateAllowedParameterValues(arg1, template, mergedExtraVars);

    const job = await towerClient.launchTemplateByName(
      template.name,
      mergedExtraVars
    );

    const jobUrl = `${config.tower.url}/#/jobs/job/${job.id}`;
    console.log(`Launched: ${template.name}`);
    console.log(`Job ID:   ${job.id}`);
    console.log(`URL:      ${jobUrl}`);
    console.log("---");

    const pollIntervalMs = (config.pollIntervalSeconds || 10) * 1000;
    while (true) {
      const liveJob = await towerClient.getJob(job.id);
      console.log(formatJob(liveJob));
      console.log("---");

      if (["successful", "failed", "error", "canceled"].includes(liveJob.status)) {
        if (liveJob.status === "successful") {
          persistDeploymentInfo(liveJob);
        }
        process.exit(liveJob.status === "successful" ? 0 : 2);
      }

      await sleep(pollIntervalMs);
    }
  }

  if (command === "status") {
    if (!arg1) {
      throw new Error("Missing jobId for status command.");
    }

    const job = await towerClient.getJob(Number(arg1));
    if (job.status === "successful") {
      persistDeploymentInfo(job);
    }
    console.log(formatJob(job));
    return;
  }

  if (command === "logs") {
    if (!arg1) {
      throw new Error("Missing jobId for logs command.");
    }

    const logs = await towerClient.getJobLogs(Number(arg1));
    console.log(logs);
    return;
  }

  if (command === "watch") {
    if (!arg1) {
      throw new Error("Missing jobId for watch command.");
    }

    const pollIntervalMs = (config.pollIntervalSeconds || 10) * 1000;
    const jobId = Number(arg1);

    while (true) {
      const job = await towerClient.getJob(jobId);
      console.log(formatJob(job));
      console.log("---");

      if (["successful", "failed", "error", "canceled"].includes(job.status)) {
        if (job.status === "successful") {
          persistDeploymentInfo(job);
        }
        process.exit(job.status === "successful" ? 0 : 2);
      }

      await sleep(pollIntervalMs);
    }
  }

  if (command === "install-tools") {
    const targetComputerName = arg1 || getDeploymentTargetFromState();

    if (!targetComputerName) {
      throw new Error(
        "Missing computerName for install-tools command. Provide the Windows hostname or IP address, or run status/watch on a completed deployment first so the last deployment target is saved."
      );
    }

    if (!arg1) {
      console.log(`Using last deployed target: ${targetComputerName}`);
    }

    await installToolsOnWindows(targetComputerName, restArgs, config);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
    console.error(`Network error: Cannot reach ${error.hostname || "the Tower server"}.`);
    console.error("Make sure you are connected to the corporate VPN or internal network.");
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
