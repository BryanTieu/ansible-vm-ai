# Tower Automation Instructions

When working in this workspace, treat the Tower CLI as the execution backend.

## Available commands
- `node src/cli.js launch <templateKey> [key=value ...]`
- `node src/cli.js install-tools <computerName> [toolName ...]`
- `node src/cli.js status <jobId>`
- `node src/cli.js logs <jobId>`
- `node src/cli.js watch <jobId>`

## How to help the user
- Prefer running the CLI instead of suggesting manual API calls.
- When asked to launch a template, inspect `config.json` for required parameters and available template keys.
- If the user already provided parameter values, pass them as `key=value` pairs to the launch command.
- If a template has defaulted parameters in `extraVars`, do not ask for those values unless the user explicitly wants to override them.
- If a required parameter lists `allowedValues`, only suggest or accept values from that list.
- If a template has required parameters and the user did not provide them, ask only for the missing values before launching.
- For `globalCxDeploymentV2`, prompt for any missing `requested_os`, `requested_size`, `requested_location`, `requested_hostname_type`, or `ticket` values instead of guessing.
- Treat deployment as OS-agnostic: if the selected Tower template supports the requested OS and provided credentials/permissions are valid, proceed with deployment.
- For post-deployment setup, use `install-tools` to copy packages from the local `tools/` directory to the target VM.
- If the deployment job has completed successfully, use the hostname or IP captured from the Tower job artifacts instead of asking the user again.
- If the target hostname, IP, or remote access credentials are missing, ask only for the missing connection details before running `install-tools`.
- When asked to monitor a job, use the watch command or status command as appropriate.
- When asked to analyze failures, fetch logs first and then summarize them.
- If a deployment fails and the logs indicate insufficient capacity, datastore exhaustion, or lack of space, run `capacityReport` to verify available capacity before responding.
- After running `capacityReport` for a space or capacity failure, tell the user what capacity is available and recommend a viable alternative deployment option based on that report.
- Treat the CLI as the source of truth for Tower state.

## Current supported workflow
- `capacityReport` maps to the Tower template `Report - Self-Service Available Capacity`.
- `globalCxDeploymentV2` maps to the Tower template `Self-Service - Deployment for Global CX Team_V2`.
- `globalCxDeleteCxCse` maps to the Tower template `Self-Service - Delete for Global CX/CSE Teams`.
- If `globalCxDeploymentV2` fails due to space or capacity constraints, inspect the deployment logs and then launch `capacityReport` to confirm capacity.
- When `capacityReport` confirms limited capacity, summarize the available options and recommend one the user can run instead of the failed request.
- `install-tools` copies all files from `tools/` by default and extracts ZIP files under the configured remote destination root.
- Successful deployment jobs expose `hostname`, `fqdn`, and `ip` in Tower artifacts, and the CLI saves the latest deployment target for reuse by `install-tools`.
- `install-tools` uses the general OS login credentials from `remoteAccess` in config.json; legacy `windowsRemote` naming is still supported for compatibility.
- `install-tools` supports Windows over WinRM and Unix-like systems (Rocky/Alma/RedHat/AIX) over SSH/SCP.
- For Unix-like targets, prefer key-based SSH access (`remoteAccess.sshKeyPath` or `REMOTE_ACCESS_SSH_KEY_PATH`) and use `--os=linux`, `--os=aix`, or `--os=unix` when OS auto-detection is ambiguous.
- On Windows clients, Unix-like targets can use password auth through PuTTY `plink`/`pscp` when `remoteAccess.unixPassword` is configured.
- `globalCxDeleteCxCse` requires these parameters:
	- `vm_guest_in` — the short hostname of the VM to delete (e.g. `waldevtsmvbt201`)
	- `confirm_delete` — must be `YES` or `NO`; always prompt the user to confirm before passing `YES`
- Before launching `globalCxDeleteCxCse`, always ask the user to explicitly confirm deletion of the named host.
- `globalCxDeploymentV2` requires these parameters:
	- `requested_os`
	- `requested_size`
	- `requested_location`
	- `requested_hostname_type`
	- `ticket`
- `globalCxDeploymentV2` defaults `requested_product` to `TechSupport MV`.
- `globalCxDeploymentV2` valid `requested_os` values are:
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
- `globalCxDeploymentV2` valid `requested_size` values are:
	- `Small`
	- `Medium`
	- `Large`

## Constraints
- MCP is unavailable due to organization policy.
- Do not assume additional Tower templates exist unless they are added to `config.json`.
