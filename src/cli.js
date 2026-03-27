#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { loadConfig } from "./config.js";
import { getProjectRoot } from "./config.js";
import { TowerClient } from "./tower-client.js";

function printUsage() {
  console.log(`Usage:
  node src/cli.js launch <templateKey> [key=value ...]
  node src/cli.js status <jobId>
  node src/cli.js logs <jobId>
  node src/cli.js watch <jobId>
  node src/cli.js install-tools [--os=windows|linux|aix|unix] <computerName> [toolName ...]
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

function isLinuxRequestedOs(requestedOs) {
  if (typeof requestedOs !== "string") {
    return false;
  }

  const normalizedRequestedOs = requestedOs.toLowerCase();
  return (
    normalizedRequestedOs.includes("linux") ||
    normalizedRequestedOs.includes("redhat") ||
    normalizedRequestedOs.includes("alma") ||
    normalizedRequestedOs.includes("rocky")
  );
}

function isWindowsRequestedOs(requestedOs) {
  if (typeof requestedOs !== "string") {
    return false;
  }

  return requestedOs.toLowerCase().includes("windows");
}

function isAixRequestedOs(requestedOs) {
  if (typeof requestedOs !== "string") {
    return false;
  }

  return requestedOs.toLowerCase().includes("aix");
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

function persistDeploymentInfo(job, metadata = {}) {
  const deploymentInfo = parseDeploymentArtifacts(job);

  if (!deploymentInfo) {
    return null;
  }

  const currentState = loadState();
  const previousDeployment = currentState.lastDeployment || {};
  const requestedOs =
    metadata.requestedOs !== undefined ? metadata.requestedOs : previousDeployment.requestedOs;

  saveState({
    ...currentState,
    lastDeployment: {
      ...previousDeployment,
      jobId: job.id,
      name: job.name,
      ...deploymentInfo,
      ...(requestedOs ? { requestedOs } : {}),
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

function getLastDeploymentFromState() {
  return loadState().lastDeployment || null;
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

function getRemoteAccessConfig(config) {
  const remoteAccessConfig = config.remoteAccess || config.windowsRemote || {};
  const username =
    process.env.REMOTE_ACCESS_USERNAME ||
    process.env.WINDOWS_VM_USERNAME ||
    remoteAccessConfig.username;
  const password =
    process.env.REMOTE_ACCESS_PASSWORD ||
    process.env.WINDOWS_VM_PASSWORD ||
    remoteAccessConfig.password;

  if (!username || !password) {
    throw new Error(
      "Missing remote access credentials. Set remoteAccess.username and remoteAccess.password in config.json or provide REMOTE_ACCESS_USERNAME and REMOTE_ACCESS_PASSWORD environment variables. Legacy windowsRemote and WINDOWS_VM_* settings are also supported."
    );
  }

  return {
    username,
    password,
    port:
      process.env.REMOTE_ACCESS_PORT !== undefined
        ? Number(process.env.REMOTE_ACCESS_PORT)
        : process.env.WINDOWS_VM_PORT !== undefined
          ? Number(process.env.WINDOWS_VM_PORT)
          : remoteAccessConfig.port,
    useSsl:
      process.env.REMOTE_ACCESS_USE_SSL !== undefined
        ? process.env.REMOTE_ACCESS_USE_SSL === "true"
        : process.env.WINDOWS_VM_USE_SSL !== undefined
          ? process.env.WINDOWS_VM_USE_SSL === "true"
          : Boolean(remoteAccessConfig.useSsl),
    skipCertificateCheck:
      process.env.REMOTE_ACCESS_SKIP_CERT_CHECK !== undefined
        ? process.env.REMOTE_ACCESS_SKIP_CERT_CHECK === "true"
        : process.env.WINDOWS_VM_SKIP_CERT_CHECK !== undefined
          ? process.env.WINDOWS_VM_SKIP_CERT_CHECK === "true"
          : Boolean(remoteAccessConfig.skipCertificateCheck),
    destinationRoot:
      process.env.REMOTE_ACCESS_DESTINATION_ROOT ||
      process.env.WINDOWS_VM_DESTINATION_ROOT ||
      remoteAccessConfig.destinationRoot ||
      "C:\\Tools",
  };
}

async function installToolsOnWindows(computerName, requestedToolNames, config) {
  const toolFiles = resolveToolFiles(requestedToolNames);
  const remoteAccessConfig = getRemoteAccessConfig(config);
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
    remoteAccessConfig.username,
    "-Password",
    remoteAccessConfig.password,
    "-DestinationRoot",
    remoteAccessConfig.destinationRoot,
    "-ToolPathsJson",
    JSON.stringify(toolFiles.map((toolFile) => toolFile.filePath)),
  ];

  if (remoteAccessConfig.port !== undefined && !Number.isNaN(remoteAccessConfig.port)) {
    powershellArgs.push("-Port", String(remoteAccessConfig.port));
  }

  if (remoteAccessConfig.useSsl) {
    powershellArgs.push("-UseSsl");
  }

  if (remoteAccessConfig.skipCertificateCheck) {
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

function getUnixRemoteAccessConfig(config) {
  const remoteAccessConfig = config.remoteAccess || config.windowsRemote || {};
  const username =
    process.env.REMOTE_ACCESS_UNIX_USERNAME ||
    remoteAccessConfig.unixUsername ||
    process.env.REMOTE_ACCESS_LINUX_USERNAME ||
    remoteAccessConfig.linuxUsername ||
    process.env.REMOTE_ACCESS_USERNAME ||
    remoteAccessConfig.username;

  if (!username) {
    throw new Error(
      "Missing Unix remote username. Set remoteAccess.unixUsername (or remoteAccess.linuxUsername) in config.json or provide REMOTE_ACCESS_UNIX_USERNAME/REMOTE_ACCESS_LINUX_USERNAME."
    );
  }

  const parsedPort =
    process.env.REMOTE_ACCESS_UNIX_PORT !== undefined
      ? Number(process.env.REMOTE_ACCESS_UNIX_PORT)
      : process.env.REMOTE_ACCESS_AIX_PORT !== undefined
        ? Number(process.env.REMOTE_ACCESS_AIX_PORT)
        : remoteAccessConfig.aixPort !== undefined
          ? Number(remoteAccessConfig.aixPort)
          : remoteAccessConfig.unixPort !== undefined
            ? Number(remoteAccessConfig.unixPort)
            :
    process.env.REMOTE_ACCESS_LINUX_PORT !== undefined
      ? Number(process.env.REMOTE_ACCESS_LINUX_PORT)
      : remoteAccessConfig.linuxPort;

  return {
    username,
    password:
      process.env.REMOTE_ACCESS_UNIX_PASSWORD ||
      process.env.REMOTE_ACCESS_AIX_PASSWORD ||
      process.env.REMOTE_ACCESS_LINUX_PASSWORD ||
      remoteAccessConfig.unixPassword ||
      remoteAccessConfig.aixPassword ||
      remoteAccessConfig.linuxPassword,
    port: Number.isFinite(parsedPort) ? parsedPort : 22,
    destinationRoot:
      process.env.REMOTE_ACCESS_UNIX_DESTINATION_ROOT ||
      process.env.REMOTE_ACCESS_AIX_DESTINATION_ROOT ||
      remoteAccessConfig.aixDestinationRoot ||
      remoteAccessConfig.unixDestinationRoot ||
      process.env.REMOTE_ACCESS_LINUX_DESTINATION_ROOT ||
      remoteAccessConfig.linuxDestinationRoot ||
      "/opt/tools",
    sshKeyPath: process.env.REMOTE_ACCESS_SSH_KEY_PATH || remoteAccessConfig.sshKeyPath,
    sshHostKey:
      process.env.REMOTE_ACCESS_SSH_HOST_KEY ||
      remoteAccessConfig.sshHostKey,
    strictHostKeyChecking:
      process.env.REMOTE_ACCESS_UNIX_STRICT_HOST_KEY_CHECKING !== undefined
        ? process.env.REMOTE_ACCESS_UNIX_STRICT_HOST_KEY_CHECKING === "true"
        : process.env.REMOTE_ACCESS_AIX_STRICT_HOST_KEY_CHECKING !== undefined
          ? process.env.REMOTE_ACCESS_AIX_STRICT_HOST_KEY_CHECKING === "true"
          : process.env.REMOTE_ACCESS_LINUX_STRICT_HOST_KEY_CHECKING !== undefined
            ? process.env.REMOTE_ACCESS_LINUX_STRICT_HOST_KEY_CHECKING === "true"
            : Boolean(
                remoteAccessConfig.unixStrictHostKeyChecking ||
                remoteAccessConfig.aixStrictHostKeyChecking ||
                remoteAccessConfig.linuxStrictHostKeyChecking
              ),
  };
}

function commandExists(command) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const lookupResult = spawnSync(lookupCommand, [command], {
    stdio: "ignore",
    shell: false,
  });

  return lookupResult.status === 0;
}

function shouldUsePuttyPasswordTransport(remoteAccessConfig) {
  if (!remoteAccessConfig.password) {
    return false;
  }

  if (process.platform !== "win32") {
    return false;
  }

  return commandExists("plink") && commandExists("pscp");
}

function quoteForPosixShell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function runExternalCommand(command, args, failureHint) {
  await new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { stdio: "inherit" });

    childProcess.on("error", reject);
    childProcess.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const hintSuffix = failureHint ? ` ${failureHint}` : "";
      reject(new Error(`${command} failed with exit code ${code}.${hintSuffix}`));
    });
  });
}

function buildSshArgs(remoteAccessConfig, destination, remoteCommand) {
  const args = [];

  if (remoteAccessConfig.sshKeyPath) {
    args.push("-i", remoteAccessConfig.sshKeyPath);
  }

  args.push("-p", String(remoteAccessConfig.port));

  if (!remoteAccessConfig.strictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }

  args.push("-o", "BatchMode=yes");

  args.push(destination, remoteCommand);
  return args;
}

function buildScpArgs(remoteAccessConfig, sourcePath, destinationPath) {
  const args = [];

  if (remoteAccessConfig.sshKeyPath) {
    args.push("-i", remoteAccessConfig.sshKeyPath);
  }

  args.push("-P", String(remoteAccessConfig.port));

  if (!remoteAccessConfig.strictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  }

  args.push("-o", "BatchMode=yes");

  args.push(sourcePath, destinationPath);
  return args;
}

function buildPlinkArgs(remoteAccessConfig, destination, remoteCommand) {
  const [username, host] = destination.split("@");
  const args = [
    "-batch",
    "-ssh",
    "-P",
    String(remoteAccessConfig.port),
    "-l",
    username,
    "-pw",
    remoteAccessConfig.password,
  ];

  if (remoteAccessConfig.sshHostKey) {
    args.push("-hostkey", remoteAccessConfig.sshHostKey);
  }

  if (remoteAccessConfig.sshKeyPath) {
    args.push("-i", remoteAccessConfig.sshKeyPath);
  }

  args.push(host, remoteCommand);
  return args;
}

function buildPscpArgs(remoteAccessConfig, sourcePath, destinationPath) {
  const destinationParts = destinationPath.split(":");
  const hostAndUser = destinationParts[0];
  const remotePath = destinationParts.slice(1).join(":");
  const [username, host] = hostAndUser.split("@");

  const args = [
    "-batch",
    "-scp",
    "-P",
    String(remoteAccessConfig.port),
    "-l",
    username,
    "-pw",
    remoteAccessConfig.password,
  ];

  if (remoteAccessConfig.sshHostKey) {
    args.push("-hostkey", remoteAccessConfig.sshHostKey);
  }

  if (remoteAccessConfig.sshKeyPath) {
    args.push("-i", remoteAccessConfig.sshKeyPath);
  }

  args.push(sourcePath, `${host}:${remotePath}`);
  return args;
}

function getUnixTransport(remoteAccessConfig) {
  if (shouldUsePuttyPasswordTransport(remoteAccessConfig)) {
    return {
      shellCommand: "plink",
      copyCommand: "pscp",
      shellArgsBuilder: buildPlinkArgs,
      copyArgsBuilder: buildPscpArgs,
      mode: "putty-password",
    };
  }

  return {
    shellCommand: "ssh",
    copyCommand: "scp",
    shellArgsBuilder: buildSshArgs,
    copyArgsBuilder: buildScpArgs,
    mode: "openssh",
  };
}

function buildRemoteExtractCommand(remoteArchivePath, extractDirectory) {
  const archivePath = quoteForPosixShell(remoteArchivePath);
  const targetDirectory = quoteForPosixShell(extractDirectory);

  return (
    `rm -rf ${targetDirectory}; ` +
    `mkdir -p ${targetDirectory}; ` +
    `if command -v unzip >/dev/null 2>&1; then ` +
    `unzip -o ${archivePath} -d ${targetDirectory} >/dev/null; ` +
    `elif command -v jar >/dev/null 2>&1; then ` +
    `(cd ${targetDirectory} && jar xf ${archivePath}); ` +
    `else ` +
    `echo ${quoteForPosixShell("No ZIP extractor found (tried unzip, jar).")} >&2; ` +
    `exit 1; ` +
    `fi`
  );
}

async function installToolsOnUnix(computerName, requestedToolNames, config) {
  const toolFiles = resolveToolFiles(requestedToolNames);
  const remoteAccessConfig = getUnixRemoteAccessConfig(config);
  const sshDestination = `${remoteAccessConfig.username}@${computerName}`;
  const unixTransport = getUnixTransport(remoteAccessConfig);

  if (
    remoteAccessConfig.password &&
    unixTransport.mode === "openssh" &&
    process.platform === "win32" &&
    !remoteAccessConfig.sshKeyPath
  ) {
    throw new Error(
      "Unix password authentication is configured, but PuTTY plink/pscp were not found in PATH. Install PuTTY tools or configure remoteAccess.sshKeyPath/REMOTE_ACCESS_SSH_KEY_PATH for key-based auth."
    );
  }

  console.log(
    `Installing ${toolFiles.length} tool(s) on ${computerName} over SSH (${unixTransport.mode})...`
  );

  const createDestinationCommand = `mkdir -p ${quoteForPosixShell(remoteAccessConfig.destinationRoot)}`;
  await runExternalCommand(
    unixTransport.shellCommand,
    unixTransport.shellArgsBuilder(remoteAccessConfig, sshDestination, createDestinationCommand),
    "For Unix/AIX targets, configure SSH key-based access via remoteAccess.sshKeyPath or REMOTE_ACCESS_SSH_KEY_PATH, or use remoteAccess.unixPassword with PuTTY plink/pscp installed on Windows."
  );

  for (const toolFile of toolFiles) {
    const remoteArchivePath = `${remoteAccessConfig.destinationRoot}/${toolFile.name}`;

    console.log(`Copying ${toolFile.name} to ${computerName}...`);
    await runExternalCommand(
      unixTransport.copyCommand,
      unixTransport.copyArgsBuilder(
        remoteAccessConfig,
        toolFile.filePath,
        `${sshDestination}:${remoteArchivePath}`
      ),
      "SCP authentication failed. Configure remoteAccess.sshKeyPath or REMOTE_ACCESS_SSH_KEY_PATH, or use remoteAccess.unixPassword with PuTTY plink/pscp installed on Windows."
    );

    const extension = path.extname(toolFile.name).toLowerCase();

    if (extension === ".tar" || extension === ".tgz" || toolFile.name.toLowerCase().endsWith(".tar.gz")) {
      const extractDirectory = `${remoteAccessConfig.destinationRoot}/${path.parse(path.parse(toolFile.name).name).name}`;
      const extractCommand =
        `rm -rf ${quoteForPosixShell(extractDirectory)} && ` +
        `mkdir -p ${quoteForPosixShell(extractDirectory)} && ` +
        `tar -xf ${quoteForPosixShell(remoteArchivePath)} -C ${quoteForPosixShell(extractDirectory)}`;

      await runExternalCommand(
        unixTransport.shellCommand,
        unixTransport.shellArgsBuilder(remoteAccessConfig, sshDestination, extractCommand),
        "Remote extraction failed on Unix target. Ensure tar is installed and SSH auth is configured."
      );

      console.log(`Extracted ${toolFile.name} to ${extractDirectory}`);
      continue;
    }

    if (extension !== ".zip") {
      console.log(`Copied ${toolFile.name} to ${remoteArchivePath}`);
      continue;
    }

    const extractDirectory = `${remoteAccessConfig.destinationRoot}/${path.parse(toolFile.name).name}`;
    const extractCommand = buildRemoteExtractCommand(remoteArchivePath, extractDirectory);

    await runExternalCommand(
      unixTransport.shellCommand,
      unixTransport.shellArgsBuilder(remoteAccessConfig, sshDestination, extractCommand),
      "Remote extraction failed on Unix target. Ensure unzip or jar is available and SSH auth is configured."
    );

    console.log(`Extracted ${toolFile.name} to ${extractDirectory}`);
  }

  console.log("Tool installation complete.");
}

function parseInstallToolsArguments(args) {
  const positionalArgs = [];
  let osHint;

  for (const arg of args) {
    if (arg.startsWith("--os=")) {
      osHint = arg.slice("--os=".length).trim().toLowerCase();
      continue;
    }

    positionalArgs.push(arg);
  }

  if (
    osHint &&
    osHint !== "windows" &&
    osHint !== "linux" &&
    osHint !== "aix" &&
    osHint !== "unix"
  ) {
    throw new Error(
      `Invalid --os value '${osHint}'. Allowed values: windows, linux, aix, unix.`
    );
  }

  return {
    osHint,
    targetComputerName: positionalArgs[0],
    requestedToolNames: positionalArgs.slice(1),
  };
}

function resolveInstallToolsOs(osHint) {
  if (osHint) {
    if (osHint === "linux" || osHint === "aix") {
      return "unix";
    }

    return osHint;
  }

  const lastDeployment = getLastDeploymentFromState();
  if (!lastDeployment?.requestedOs) {
    return "windows";
  }

  if (isWindowsRequestedOs(lastDeployment.requestedOs)) {
    return "windows";
  }

  if (isAixRequestedOs(lastDeployment.requestedOs)) {
    return "unix";
  }

  if (isLinuxRequestedOs(lastDeployment.requestedOs)) {
    return "unix";
  }

  return "windows";
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
          persistDeploymentInfo(liveJob, {
            requestedOs: arg1 === "globalCxDeploymentV2" ? mergedExtraVars.requested_os : undefined,
          });
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
    const parsedInstallToolsArgs = parseInstallToolsArguments([
      ...(arg1 ? [arg1] : []),
      ...restArgs,
    ]);
    const targetComputerName =
      parsedInstallToolsArgs.targetComputerName || getDeploymentTargetFromState();

    if (!targetComputerName) {
      throw new Error(
        "Missing computerName for install-tools command. Provide the hostname or IP address, or run status/watch on a completed deployment first so the last deployment target is saved."
      );
    }

    if (!parsedInstallToolsArgs.targetComputerName) {
      console.log(`Using last deployed target: ${targetComputerName}`);
    }

    const installTargetOs = resolveInstallToolsOs(parsedInstallToolsArgs.osHint);

    if (installTargetOs === "unix") {
      await installToolsOnUnix(targetComputerName, parsedInstallToolsArgs.requestedToolNames, config);
      return;
    }

    await installToolsOnWindows(targetComputerName, parsedInstallToolsArgs.requestedToolNames, config);
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
