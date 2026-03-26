# Tower Automation CLI

This project provides a deterministic Tower automation backend with an AI-friendly workflow on top.

## What it does
- Launch the `Report - Self-Service Available Capacity` Tower job template
- Launch the `Self-Service - Deployment for Global CX Team_V2` Tower job template
- Copy and extract tool packages from the local `tools/` directory onto a Windows VM over PowerShell remoting
- Query job status
- Retrieve job logs
- Watch a job until completion

## Setup
1. Install dependencies:
   - `npm install`
2. Copy `config-example.json` to `config.json`
3. Fill in your Tower credentials in `config.json`
4. If you want to install tools on Windows VMs, fill in the `windowsRemote` credentials in `config.json` or set `WINDOWS_VM_USERNAME` and `WINDOWS_VM_PASSWORD`

## Commands
- `node src/cli.js launch capacityReport`
- `node src/cli.js launch globalCxDeploymentV2 requested_os="RedHat 9.7" requested_size=Medium requested_location=US requested_hostname_type=New ticket=CX-1234`
- `node src/cli.js install-tools <computerName>`
- `node src/cli.js install-tools <computerName> UV_WINDOWS_11.4.1`
- `node src/cli.js status <jobId>`
- `node src/cli.js logs <jobId>`
- `node src/cli.js watch <jobId>`

## Template parameters
- `globalCxDeploymentV2` requires:
   - `requested_os`
   - `requested_size`
   - `requested_location`
   - `requested_hostname_type`
   - `ticket`

- `globalCxDeploymentV2` defaults `requested_product` to `TechSupport MV`
- Valid `requested_os` values:
   - `Alma Linux 8.9`
   - `Alma Linux 9.3`
   - `RedHat 8.9`
   - `RedHat 8.10`
   - `RedHat 9.6`
   - `RedHat 9.7`
   - `Rocky Linux 9.3`
   - `Rocky Linux 8.9`
   - `Windows 11`
   - `Windows 2019`
   - `Windows 2022`
   - `Windows 2025`
- Valid `requested_size` values:
   - `Small`
   - `Medium`
   - `Large`

If a required parameter is missing, the CLI fails with a clear error so the AI layer can ask only for the missing values before retrying.

If a parameter has a restricted list of valid values, the CLI rejects invalid input before launching the Tower job and prints the allowed values in the error message.

If a deployment job fails and the logs point to insufficient capacity or lack of space, the AI layer should retrieve the job logs and then run `capacityReport` to verify available capacity.

After verifying capacity, the AI layer should tell the user what is currently available and recommend a viable alternative deployment option instead of the failed request.

## Windows tool installation
- `install-tools` copies files from the local `tools/` directory to the target Windows machine over PowerShell remoting.
- Successful deployment jobs expose `hostname`, `fqdn`, and `ip` in Tower artifacts, and the CLI prints and saves those values.
- If you do not specify tool names, all files in `tools/` are copied.
- ZIP files are extracted under the configured remote destination root. Non-ZIP files are copied as-is.
- The command requires the target `computerName` plus Windows credentials from `config.json` or environment variables.
- If you omit `computerName`, `install-tools` reuses the last successful deployment target saved from `launch`, `status`, or `watch`.

## AI layer
The file `copilot-instructions.md` tells Copilot to use this CLI as the backend. That gives you an AI orchestration layer even though MCP servers are disabled by policy.

## VS Code tasks
Use Task: Run Task and choose one of:
- `tower: launch capacity report`
- `tower: status`
- `tower: logs`
- `tower: watch`
