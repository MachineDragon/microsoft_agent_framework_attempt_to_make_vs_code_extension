import * as http from "node:http";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

type ServiceStatus = {
  customBackend: "unknown" | "starting" | "ready" | "missing" | "error";
  devuiBackend: "unknown" | "ready" | "missing";
  ollama: "unknown" | "ready" | "missing";
  message: string;
};

const VIEW_TYPE = "budai.main";
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";
const MINIMUM_PYTHON_VERSION = { major: 3, minor: 10 };
const OLLAMA_CREDENTIAL_STORAGE_ID = "budai.ollamaApiKey";
const DEFAULT_AGENT_IDS = [
  "code_writer_agent",
  "data_analyst_agent",
  "devops_agent",
  "file_manager_agent",
  "planner_agent",
  "reviewer_agent",
  "shell_executor_agent",
  "web_researcher_agent",
];

let panel: vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let backendProcess: ChildProcessWithoutNullStreams | undefined;
let backendStartPromise: Promise<void> | undefined;
let lastServiceStatus: ServiceStatus = {
  customBackend: "unknown",
  devuiBackend: "unknown",
  ollama: "unknown",
  message: "BudAI services have not been checked yet.",
};

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("BudAI");
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "budai.open";
  context.subscriptions.push(outputChannel, statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("budai.open", () => openBudAI(context)),
    vscode.commands.registerCommand("budai.restartServices", () => restartServices(context)),
    vscode.commands.registerCommand("budai.checkServices", () => checkServices(context, { notify: true })),
    vscode.commands.registerCommand("budai.openOllamaDownload", () => openOllamaDownload()),
  );
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("budai.launcher", new BudAIActivityViewProvider(context)));

  updateStatusBar();
  outputChannel.appendLine("BudAI extension activated.");

  if (process.env.BUDAI_OPEN_ON_ACTIVATION === "1") {
    void openBudAI(context);
  }
}

class BudAIActivityViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
  </style>
</head>
<body>Opening BudAI...</body>
</html>`;
    void openBudAI(this.context);
  }
}

export function deactivate() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
  outputChannel?.appendLine("BudAI extension deactivated.");
}

async function openBudAI(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "BudAI",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "custom-ui", "dist")],
    },
  );

  panel.onDidDispose(() => {
    panel = undefined;
  }, null, context.subscriptions);

  panel.webview.onDidReceiveMessage((message) => handleWebviewMessage(context, message), undefined, context.subscriptions);
  panel.webview.html = await getWebviewHtml(context, panel.webview);

  const config = vscode.workspace.getConfiguration("budai");
  if (config.get<boolean>("backend.autoStart", true)) {
    void checkServices(context, { startBackend: true, notify: false });
  }
}

async function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview) {
  const nonce = getNonce();
  const config = getRuntimeConfig();
  const bundledHtml = await getBundledUiHtml(context, webview, config);

  if (bundledHtml) {
    return bundledHtml;
  }

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*;">
  <title>BudAI</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    main { display: grid; min-height: 100vh; place-items: center; padding: 32px; box-sizing: border-box; }
    section { width: min(760px, 100%); border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); padding: 24px; border-radius: 8px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { line-height: 1.5; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 8px 12px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-left: 8px; }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 4px; }
    .grid { display: grid; gap: 8px; margin: 16px 0; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>BudAI</h1>
      <p>Extension shell is running. The next implementation slice will mount the existing React app here and pass it this runtime config.</p>
      <div class="grid">
        <div>Custom backend: <code id="customBackend"></code></div>
        <div>DevUI backend: <code id="devuiBackend"></code></div>
        <div>Ollama: <code id="ollamaEndpoint"></code></div>
      </div>
      <button id="checkBackend">Check Backend</button>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const config = ${JSON.stringify(config)};
    document.getElementById("customBackend").textContent = config.customBackendBaseUrl;
    document.getElementById("devuiBackend").textContent = config.devuiBackendBaseUrl;
    document.getElementById("ollamaEndpoint").textContent = config.ollamaEndpoint;
    document.getElementById("checkBackend").addEventListener("click", () => vscode.postMessage({ type: "checkBackend" }));
  </script>
</body>
</html>`;
}

async function getBundledUiHtml(context: vscode.ExtensionContext, webview: vscode.Webview, config: ReturnType<typeof getRuntimeConfig>) {
  const distRoot = vscode.Uri.joinPath(context.extensionUri, "custom-ui", "dist");
  const indexUri = vscode.Uri.joinPath(distRoot, "index.html");

  let html: string;
  try {
    html = await fs.readFile(indexUri.fsPath, "utf8");
  } catch {
    return undefined;
  }

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
    "connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  ].join("; ");

  const runtimeScript = `<script>window.__BUDAI_CONFIG__=${JSON.stringify(config)};</script>`;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`;

  return html
    .replace(/<title>.*?<\/title>/, "<title>BudAI</title>")
    .replace(/<head>/, `<head>\n    ${cspMeta}`)
    .replace(/(<script\s+type="module"[^>]+src=")\.?\/([^">]+)("[^>]*><\/script>)/g, (_match, before, assetPath, after) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, ...assetPath.split("/")));
      return `${before}${uri}${after}`;
    })
    .replace(/(<link\s+[^>]+href=")\.?\/([^">]+)("[^>]*>)/g, (_match, before, assetPath, after) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, ...assetPath.split("/")));
      return `${before}${uri}${after}`;
    })
    .replace(/<body>/, `<body>\n  ${runtimeScript}`);
}

async function handleWebviewMessage(context: vscode.ExtensionContext, message: unknown) {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return;
  }

  const type = String((message as { type: unknown }).type);
  if (type === "checkBackend") {
    await checkServices(context, { startBackend: true, notify: true });
    return;
  }

  if (type === "budai.request") {
    await handleBudAIRequest(context, message as { requestId?: unknown; command?: unknown; payload?: unknown });
  }
}

async function handleBudAIRequest(
  context: vscode.ExtensionContext,
  message: { requestId?: unknown; command?: unknown; payload?: unknown },
) {
  const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
  if (!requestId || !panel) {
    return;
  }

  try {
    const command = String(message.command || "");
    let result: unknown;
    if (command === "settings.get") {
      result = await getSecretSettings(context);
    } else if (command === "settings.update") {
      result = await updateSecretSettings(context, message.payload);
    } else {
      throw new Error(`Unknown BudAI request: ${command}`);
    }

    await panel.webview.postMessage({ type: "budai.response", requestId, ok: true, result });
  } catch (error) {
    await panel.webview.postMessage({
      type: "budai.response",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function getSecretSettings(context: vscode.ExtensionContext) {
  const apiKey = await getOllamaApiKeySecret(context);
  return { ollama_api_key_configured: Boolean(apiKey) };
}

async function getOllamaApiKeySecret(context: vscode.ExtensionContext) {
  const storedSecret = (await context.secrets.get(OLLAMA_CREDENTIAL_STORAGE_ID))?.trim() || "";
  if (storedSecret) {
    return storedSecret;
  }

  const legacySettingsFile = getLegacySettingsFile(context);
  try {
    const legacySettings = JSON.parse(await fs.readFile(legacySettingsFile, "utf8")) as { ollama_api_key?: unknown };
    const legacyApiKey = typeof legacySettings.ollama_api_key === "string" ? legacySettings.ollama_api_key.trim() : "";
    if (legacyApiKey) {
      await context.secrets.store(OLLAMA_CREDENTIAL_STORAGE_ID, legacyApiKey);
      await fs.rm(legacySettingsFile, { force: true });
      return legacyApiKey;
    }
  } catch {
    // No legacy settings file to migrate.
  }

  return "";
}

function getLegacySettingsFile(context: vscode.ExtensionContext) {
  return path.join(context.globalStorageUri.fsPath, "settings.local");
}

async function updateSecretSettings(context: vscode.ExtensionContext, payload: unknown) {
  const settings = payload && typeof payload === "object"
    ? payload as { ollama_api_key?: unknown; clear_ollama_api_key?: unknown }
    : {};

  if (settings.clear_ollama_api_key === true) {
    await context.secrets.delete(OLLAMA_CREDENTIAL_STORAGE_ID);
    await fs.rm(getLegacySettingsFile(context), { force: true });
    await syncBackendSettings({ clear_ollama_api_key: true });
    return { ollama_api_key_configured: false };
  }

  if (typeof settings.ollama_api_key === "string") {
    const apiKey = settings.ollama_api_key.trim();
    if (apiKey) {
      await context.secrets.store(OLLAMA_CREDENTIAL_STORAGE_ID, apiKey);
      await syncBackendSettings({ ollama_api_key: apiKey });
      return { ollama_api_key_configured: true };
    }
  }

  return getSecretSettings(context);
}

async function syncBackendSettings(settings: { ollama_api_key?: string; clear_ollama_api_key?: boolean }) {
  const config = getRuntimeConfig();
  const backendReady = await isHttpEndpointReady(`${config.customBackendBaseUrl}/health`);
  if (!backendReady) {
    return;
  }

  const response = await httpJsonRequest(`${config.customBackendBaseUrl}/api/settings`, "PUT", settings);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`BudAI backend rejected settings update with HTTP ${response.statusCode}.`);
  }
}

async function restartServices(context: vscode.ExtensionContext) {
  outputChannel.appendLine("Restart services requested.");
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
    backendProcess = undefined;
  }
  backendStartPromise = undefined;
  await checkServices(context, { startBackend: true, notify: true });
}

async function checkServices(
  context: vscode.ExtensionContext,
  options: { startBackend?: boolean; notify?: boolean } = {},
) {
  const config = getRuntimeConfig();
  updateServiceStatus({ ...lastServiceStatus, customBackend: "starting", message: "Checking BudAI local services..." });

  let customBackendReady = await isHttpEndpointReady(`${config.customBackendBaseUrl}/health`);
  if (!customBackendReady && options.startBackend) {
    await startCustomBackend(context, config.customBackendBaseUrl);
    customBackendReady = await waitForHttpEndpoint(`${config.customBackendBaseUrl}/health`, 12000);
  }

  const devuiReady = await isHttpEndpointReady(`${config.devuiBackendBaseUrl}/health`);
  const ollamaReady = await isHttpEndpointReady(`${config.ollamaEndpoint}/api/tags`);
  const messageParts = [
    customBackendReady ? "custom backend ready" : "custom backend not reachable",
    devuiReady ? "DevUI backend ready" : "DevUI backend not reachable",
    ollamaReady ? "Ollama ready" : "Ollama not detected",
  ];

  updateServiceStatus({
    customBackend: customBackendReady ? "ready" : "missing",
    devuiBackend: devuiReady ? "ready" : "missing",
    ollama: ollamaReady ? "ready" : "missing",
    message: `BudAI services: ${messageParts.join(", ")}.`,
  });

  if (!ollamaReady) {
    void promptForOllamaDownload(options.notify === true);
  } else if (options.notify) {
    await vscode.window.showInformationMessage(lastServiceStatus.message);
  }
}

async function startCustomBackend(context: vscode.ExtensionContext, customBackendBaseUrl: string) {
  if (backendProcess && !backendProcess.killed) {
    return;
  }
  if (backendStartPromise) {
    return backendStartPromise;
  }

  backendStartPromise = startCustomBackendInner(context, customBackendBaseUrl).finally(() => {
    backendStartPromise = undefined;
  });
  return backendStartPromise;
}

async function startCustomBackendInner(context: vscode.ExtensionContext, customBackendBaseUrl: string) {
  if (backendProcess && !backendProcess.killed) {
    return;
  }

  const configuredPython = vscode.workspace.getConfiguration("budai").get<string>("backend.pythonPath", "python");
  const pythonStatus = await checkPythonVersion(configuredPython);
  if (!pythonStatus.ok) {
    const detail = pythonStatus.version
      ? `Detected Python ${pythonStatus.version}, but BudAI needs Python ${MINIMUM_PYTHON_VERSION.major}.${MINIMUM_PYTHON_VERSION.minor}+.`
      : `BudAI could not find Python at '${configuredPython}'.`;
    updateServiceStatus({ ...lastServiceStatus, customBackend: "missing", message: `${detail} Install Python and run BudAI: Check Local Services again.` });
    void promptForPythonDownload(detail);
    return;
  }

  const backendDir = await getBackendDir(context);
  const serverPath = path.join(backendDir, "server.py");
  try {
    await fs.access(serverPath);
  } catch {
    outputChannel.appendLine(`Custom backend source not found at ${serverPath}.`);
    return;
  }

  const parsedUrl = new URL(customBackendBaseUrl);
  let pythonPath: string;
  try {
    pythonPath = await ensureBackendPython(context, backendDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateServiceStatus({ ...lastServiceStatus, customBackend: "error", message: `Failed to prepare BudAI Python backend: ${message}` });
    void vscode.window.showErrorMessage(`Failed to prepare BudAI Python backend: ${message}`, "Download Python", "Open BudAI Python Setting")
      .then((choice) => {
        if (choice === "Download Python") {
          return openPythonDownload();
        }
        if (choice === "Open BudAI Python Setting") {
          return vscode.commands.executeCommand("workbench.action.openSettings", "budai.backend.pythonPath");
        }
        return undefined;
      });
    return;
  }
  const args = ["-m", "uvicorn", "server:app", "--host", parsedUrl.hostname, "--port", parsedUrl.port || "8081"];
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  const settingsFile = getLegacySettingsFile(context);
  const ollamaApiKey = await getOllamaApiKeySecret(context);
  const agentsDir = await ensureAgentStorage(context);
  const userDataDir = path.join(context.globalStorageUri.fsPath, "user-data");
  await fs.mkdir(userDataDir, { recursive: true });

  outputChannel.appendLine(`Starting custom backend: ${pythonPath} ${args.join(" ")}`);
  backendProcess = spawn(pythonPath, args, {
    cwd: backendDir,
    env: {
      ...process.env,
      BUDAI_EXTENSION_ROOT: context.extensionUri.fsPath,
      BUDAI_WORKSPACE_ROOT: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath,
      BUDAI_AGENTS_DIR: agentsDir,
      BUDAI_USER_DATA_DIR: userDataDir,
      BUDAI_SETTINGS_FILE: settingsFile,
      BUDAI_DISABLE_SETTINGS_FILE: "1",
      ...(ollamaApiKey ? { OLLAMA_API_KEY: ollamaApiKey } : {}),
      PYTHONUNBUFFERED: "1",
    },
  });

  backendProcess.stdout.on("data", (data: Buffer) => outputChannel.append(data.toString()));
  backendProcess.stderr.on("data", (data: Buffer) => outputChannel.append(data.toString()));
  backendProcess.on("error", (error) => {
    updateServiceStatus({ ...lastServiceStatus, customBackend: "error", message: `Failed to start custom backend: ${error.message}` });
  });
  backendProcess.on("exit", (code) => {
    outputChannel.appendLine(`BudAI custom backend exited with code ${code ?? "unknown"}.`);
    backendProcess = undefined;
  });
}

async function ensureAgentStorage(context: vscode.ExtensionContext) {
  const agentsDir = path.join(context.globalStorageUri.fsPath, "agents");
  await fs.mkdir(agentsDir, { recursive: true });

  for (const agentId of DEFAULT_AGENT_IDS) {
    const sourceDir = path.join(context.extensionUri.fsPath, "bundled-agents", agentId);
    const targetDir = path.join(agentsDir, agentId);
    try {
      await fs.access(sourceDir);
    } catch {
      continue;
    }
    try {
      await fs.access(targetDir);
    } catch {
      await fs.cp(sourceDir, targetDir, { recursive: true });
    }
  }

  return agentsDir;
}

async function getBackendDir(context: vscode.ExtensionContext) {
  const bundledBackendDir = path.join(context.extensionUri.fsPath, "bundled-backend");
  try {
    await fs.access(path.join(bundledBackendDir, "server.py"));
    return bundledBackendDir;
  } catch {
    return path.join(context.extensionUri.fsPath, "custom-ui", "backend");
  }
}

async function ensureBackendPython(context: vscode.ExtensionContext, backendDir: string) {
  const configuredPython = vscode.workspace.getConfiguration("budai").get<string>("backend.pythonPath", "python");
  const requirementsPath = path.join(backendDir, "requirements.txt");
  try {
    await fs.access(requirementsPath);
  } catch {
    return configuredPython;
  }

  const venvDir = path.join(context.globalStorageUri.fsPath, "backend-venv");
  const venvPython = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");

  try {
    await fs.access(venvPython);
  } catch {
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    outputChannel.appendLine(`Creating BudAI backend Python environment at ${venvDir}.`);
    await runProcess(configuredPython, ["-m", "venv", venvDir], backendDir);
  }

  const stampPath = path.join(venvDir, ".budai-requirements-installed");
  const requirementsStat = await fs.stat(requirementsPath);
  let needsInstall = true;
  try {
    const stamp = Number(await fs.readFile(stampPath, "utf8"));
    needsInstall = Number.isNaN(stamp) || stamp < requirementsStat.mtimeMs;
  } catch {
    needsInstall = true;
  }

  if (needsInstall) {
    outputChannel.appendLine("Installing BudAI backend Python dependencies.");
    await runProcess(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], backendDir);
    await runProcess(venvPython, ["-m", "pip", "install", "-r", requirementsPath], backendDir);
    await fs.writeFile(stampPath, String(Date.now()), "utf8");
  }

  return venvPython;
}

function runProcess(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    outputChannel.appendLine(`Running: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    child.stdout.on("data", (data: Buffer) => outputChannel.append(data.toString()));
    child.stderr.on("data", (data: Buffer) => outputChannel.append(data.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

function updateServiceStatus(status: ServiceStatus) {
  lastServiceStatus = status;
  outputChannel.appendLine(status.message);
  panel?.webview.postMessage({ type: "serviceStatusChanged", status });

  if (status.customBackend === "ready" && status.ollama === "ready") {
    statusBarItem.text = "$(check) BudAI Ready";
  } else if (status.ollama === "missing") {
    statusBarItem.text = "$(warning) BudAI: Install Ollama";
  } else {
    statusBarItem.text = "$(sync~spin) BudAI Services";
  }
  statusBarItem.tooltip = status.message;
  statusBarItem.show();
}

async function promptForOllamaDownload(forcePrompt: boolean) {
  const choice = await vscode.window.showWarningMessage(
    "BudAI could not detect Ollama. Install Ollama, start it, then run BudAI: Check Local Services again.",
    forcePrompt ? { modal: false } : {},
    "Download Ollama",
    "Not Now",
  );
  if (choice === "Download Ollama") {
    await openOllamaDownload();
  }
}

async function openOllamaDownload() {
  await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD_URL));
}

async function promptForPythonDownload(detail: string) {
  const choice = await vscode.window.showWarningMessage(
    `${detail} Install Python ${MINIMUM_PYTHON_VERSION.major}.${MINIMUM_PYTHON_VERSION.minor}+ and make sure it is on PATH, then run BudAI: Check Local Services again.`,
    { modal: false },
    "Download Python",
    "Open BudAI Python Setting",
    "Not Now",
  );
  if (choice === "Download Python") {
    await openPythonDownload();
  } else if (choice === "Open BudAI Python Setting") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "budai.backend.pythonPath");
  }
}

async function openPythonDownload() {
  await vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD_URL));
}

async function checkPythonVersion(pythonPath: string): Promise<{ ok: boolean; version?: string }> {
  try {
    const output = await getProcessOutput(pythonPath, ["--version"]);
    const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
    if (!match) {
      return { ok: false };
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const version = `${major}.${minor}.${match[3]}`;
    return {
      ok: major > MINIMUM_PYTHON_VERSION.major || (major === MINIMUM_PYTHON_VERSION.major && minor >= MINIMUM_PYTHON_VERSION.minor),
      version,
    };
  } catch {
    return { ok: false };
  }
}

function getProcessOutput(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

function httpJsonRequest(url: string, method: "PUT", body: unknown): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsedUrl = new URL(url);
    const request = http.request(
      parsedUrl,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: responseBody }));
      },
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function getRuntimeConfig() {
  const config = vscode.workspace.getConfiguration("budai");
  const host = config.get<string>("backend.host", "127.0.0.1");
  const customPort = config.get<number>("backend.customPort", 8081);
  const devuiPort = config.get<number>("backend.devuiPort", 8080);

  return {
    serviceStatus: lastServiceStatus,
    customBackendBaseUrl: `http://${host}:${customPort}`,
    devuiBackendBaseUrl: `http://${host}:${devuiPort}`,
    ollamaEndpoint: config.get<string>("ollama.endpoint", "http://127.0.0.1:11434"),
  };
}

function updateStatusBar() {
  statusBarItem.text = "$(comment-discussion) BudAI";
  statusBarItem.tooltip = "Open BudAI";
  statusBarItem.show();
}

function isHttpEndpointReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500);
    });

    request.on("error", () => resolve(false));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.setTimeout(3000, () => {
      request.destroy(new Error("Request timed out"));
    });
  });
}

async function waitForHttpEndpoint(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHttpEndpointReady(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}