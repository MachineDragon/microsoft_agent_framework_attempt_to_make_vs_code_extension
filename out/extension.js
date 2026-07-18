"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const http = __importStar(require("node:http"));
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
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
let panel;
let statusBarItem;
let outputChannel;
let backendProcess;
let backendStartPromise;
let lastServiceStatus = {
    customBackend: "unknown",
    devuiBackend: "unknown",
    ollama: "unknown",
    message: "BudAI services have not been checked yet.",
};
function activate(context) {
    outputChannel = vscode.window.createOutputChannel("BudAI");
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = "budai.open";
    context.subscriptions.push(outputChannel, statusBarItem);
    context.subscriptions.push(vscode.commands.registerCommand("budai.open", () => openBudAI(context)), vscode.commands.registerCommand("budai.restartServices", () => restartServices(context)), vscode.commands.registerCommand("budai.checkServices", () => checkServices(context, { notify: true })), vscode.commands.registerCommand("budai.openOllamaDownload", () => openOllamaDownload()));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("budai.launcher", new BudAIActivityViewProvider(context)));
    updateStatusBar();
    outputChannel.appendLine("BudAI extension activated.");
    if (process.env.BUDAI_OPEN_ON_ACTIVATION === "1") {
        void openBudAI(context);
    }
}
class BudAIActivityViewProvider {
    context;
    constructor(context) {
        this.context = context;
    }
    resolveWebviewView(webviewView) {
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
function deactivate() {
    if (backendProcess && !backendProcess.killed) {
        backendProcess.kill();
    }
    outputChannel?.appendLine("BudAI extension deactivated.");
}
async function openBudAI(context) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
    }
    panel = vscode.window.createWebviewPanel(VIEW_TYPE, "BudAI", vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "custom-ui", "dist")],
    });
    panel.onDidDispose(() => {
        panel = undefined;
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((message) => handleWebviewMessage(context, message), undefined, context.subscriptions);
    panel.webview.html = await getWebviewHtml(context, panel.webview);
    const config = vscode.workspace.getConfiguration("budai");
    if (config.get("backend.autoStart", true)) {
        void checkServices(context, { startBackend: true, notify: false });
    }
}
async function getWebviewHtml(context, webview) {
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
async function getBundledUiHtml(context, webview, config) {
    const distRoot = vscode.Uri.joinPath(context.extensionUri, "custom-ui", "dist");
    const indexUri = vscode.Uri.joinPath(distRoot, "index.html");
    let html;
    try {
        html = await fs.readFile(indexUri.fsPath, "utf8");
    }
    catch {
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
async function handleWebviewMessage(context, message) {
    if (!message || typeof message !== "object" || !("type" in message)) {
        return;
    }
    const type = String(message.type);
    if (type === "checkBackend") {
        await checkServices(context, { startBackend: true, notify: true });
        return;
    }
    if (type === "budai.request") {
        await handleBudAIRequest(context, message);
    }
}
async function handleBudAIRequest(context, message) {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (!requestId || !panel) {
        return;
    }
    try {
        const command = String(message.command || "");
        let result;
        if (command === "settings.get") {
            result = await getSecretSettings(context);
        }
        else if (command === "settings.update") {
            result = await updateSecretSettings(context, message.payload);
        }
        else {
            throw new Error(`Unknown BudAI request: ${command}`);
        }
        await panel.webview.postMessage({ type: "budai.response", requestId, ok: true, result });
    }
    catch (error) {
        await panel.webview.postMessage({
            type: "budai.response",
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
async function getSecretSettings(context) {
    const apiKey = await getOllamaApiKeySecret(context);
    return { ollama_api_key_configured: Boolean(apiKey) };
}
async function getOllamaApiKeySecret(context) {
    const storedSecret = (await context.secrets.get(OLLAMA_CREDENTIAL_STORAGE_ID))?.trim() || "";
    if (storedSecret) {
        return storedSecret;
    }
    const legacySettingsFile = getLegacySettingsFile(context);
    try {
        const legacySettings = JSON.parse(await fs.readFile(legacySettingsFile, "utf8"));
        const legacyApiKey = typeof legacySettings.ollama_api_key === "string" ? legacySettings.ollama_api_key.trim() : "";
        if (legacyApiKey) {
            await context.secrets.store(OLLAMA_CREDENTIAL_STORAGE_ID, legacyApiKey);
            await fs.rm(legacySettingsFile, { force: true });
            return legacyApiKey;
        }
    }
    catch {
        // No legacy settings file to migrate.
    }
    return "";
}
function getLegacySettingsFile(context) {
    return path.join(context.globalStorageUri.fsPath, "settings.local");
}
async function updateSecretSettings(context, payload) {
    const settings = payload && typeof payload === "object"
        ? payload
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
async function syncBackendSettings(settings) {
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
async function restartServices(context) {
    outputChannel.appendLine("Restart services requested.");
    if (backendProcess && !backendProcess.killed) {
        backendProcess.kill();
        backendProcess = undefined;
    }
    backendStartPromise = undefined;
    await checkServices(context, { startBackend: true, notify: true });
}
async function checkServices(context, options = {}) {
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
    }
    else if (options.notify) {
        await vscode.window.showInformationMessage(lastServiceStatus.message);
    }
}
async function startCustomBackend(context, customBackendBaseUrl) {
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
async function startCustomBackendInner(context, customBackendBaseUrl) {
    if (backendProcess && !backendProcess.killed) {
        return;
    }
    const configuredPython = vscode.workspace.getConfiguration("budai").get("backend.pythonPath", "python");
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
    }
    catch {
        outputChannel.appendLine(`Custom backend source not found at ${serverPath}.`);
        return;
    }
    const parsedUrl = new URL(customBackendBaseUrl);
    let pythonPath;
    try {
        pythonPath = await ensureBackendPython(context, backendDir);
    }
    catch (error) {
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
    backendProcess = (0, node_child_process_1.spawn)(pythonPath, args, {
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
    backendProcess.stdout.on("data", (data) => outputChannel.append(data.toString()));
    backendProcess.stderr.on("data", (data) => outputChannel.append(data.toString()));
    backendProcess.on("error", (error) => {
        updateServiceStatus({ ...lastServiceStatus, customBackend: "error", message: `Failed to start custom backend: ${error.message}` });
    });
    backendProcess.on("exit", (code) => {
        outputChannel.appendLine(`BudAI custom backend exited with code ${code ?? "unknown"}.`);
        backendProcess = undefined;
    });
}
async function ensureAgentStorage(context) {
    const agentsDir = path.join(context.globalStorageUri.fsPath, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    for (const agentId of DEFAULT_AGENT_IDS) {
        const sourceDir = path.join(context.extensionUri.fsPath, "bundled-agents", agentId);
        const targetDir = path.join(agentsDir, agentId);
        try {
            await fs.access(sourceDir);
        }
        catch {
            continue;
        }
        try {
            await fs.access(targetDir);
        }
        catch {
            await fs.cp(sourceDir, targetDir, { recursive: true });
        }
    }
    return agentsDir;
}
async function getBackendDir(context) {
    const bundledBackendDir = path.join(context.extensionUri.fsPath, "bundled-backend");
    try {
        await fs.access(path.join(bundledBackendDir, "server.py"));
        return bundledBackendDir;
    }
    catch {
        return path.join(context.extensionUri.fsPath, "custom-ui", "backend");
    }
}
async function ensureBackendPython(context, backendDir) {
    const configuredPython = vscode.workspace.getConfiguration("budai").get("backend.pythonPath", "python");
    const requirementsPath = path.join(backendDir, "requirements.txt");
    try {
        await fs.access(requirementsPath);
    }
    catch {
        return configuredPython;
    }
    const venvDir = path.join(context.globalStorageUri.fsPath, "backend-venv");
    const venvPython = process.platform === "win32"
        ? path.join(venvDir, "Scripts", "python.exe")
        : path.join(venvDir, "bin", "python");
    try {
        await fs.access(venvPython);
    }
    catch {
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
    }
    catch {
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
function runProcess(command, args, cwd) {
    return new Promise((resolve, reject) => {
        outputChannel.appendLine(`Running: ${command} ${args.join(" ")}`);
        const child = (0, node_child_process_1.spawn)(command, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
        child.stdout.on("data", (data) => outputChannel.append(data.toString()));
        child.stderr.on("data", (data) => outputChannel.append(data.toString()));
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
            }
            else {
                reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
            }
        });
    });
}
function updateServiceStatus(status) {
    lastServiceStatus = status;
    outputChannel.appendLine(status.message);
    panel?.webview.postMessage({ type: "serviceStatusChanged", status });
    if (status.customBackend === "ready" && status.ollama === "ready") {
        statusBarItem.text = "$(check) BudAI Ready";
    }
    else if (status.ollama === "missing") {
        statusBarItem.text = "$(warning) BudAI: Install Ollama";
    }
    else {
        statusBarItem.text = "$(sync~spin) BudAI Services";
    }
    statusBarItem.tooltip = status.message;
    statusBarItem.show();
}
async function promptForOllamaDownload(forcePrompt) {
    const choice = await vscode.window.showWarningMessage("BudAI could not detect Ollama. Install Ollama, start it, then run BudAI: Check Local Services again.", forcePrompt ? { modal: false } : {}, "Download Ollama", "Not Now");
    if (choice === "Download Ollama") {
        await openOllamaDownload();
    }
}
async function openOllamaDownload() {
    await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD_URL));
}
async function promptForPythonDownload(detail) {
    const choice = await vscode.window.showWarningMessage(`${detail} Install Python ${MINIMUM_PYTHON_VERSION.major}.${MINIMUM_PYTHON_VERSION.minor}+ and make sure it is on PATH, then run BudAI: Check Local Services again.`, { modal: false }, "Download Python", "Open BudAI Python Setting", "Not Now");
    if (choice === "Download Python") {
        await openPythonDownload();
    }
    else if (choice === "Open BudAI Python Setting") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "budai.backend.pythonPath");
    }
}
async function openPythonDownload() {
    await vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD_URL));
}
async function checkPythonVersion(pythonPath) {
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
    }
    catch {
        return { ok: false };
    }
}
function getProcessOutput(command, args) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, { env: { ...process.env, PYTHONUNBUFFERED: "1" } });
        let output = "";
        child.stdout.on("data", (data) => { output += data.toString(); });
        child.stderr.on("data", (data) => { output += data.toString(); });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve(output.trim());
            }
            else {
                reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
            }
        });
    });
}
function httpJsonRequest(url, method, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const parsedUrl = new URL(url);
        const request = http.request(parsedUrl, {
            method,
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        }, (response) => {
            let responseBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { responseBody += chunk; });
            response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: responseBody }));
        });
        request.on("error", reject);
        request.write(payload);
        request.end();
    });
}
function getRuntimeConfig() {
    const config = vscode.workspace.getConfiguration("budai");
    const host = config.get("backend.host", "127.0.0.1");
    const customPort = config.get("backend.customPort", 8081);
    const devuiPort = config.get("backend.devuiPort", 8080);
    return {
        serviceStatus: lastServiceStatus,
        customBackendBaseUrl: `http://${host}:${customPort}`,
        devuiBackendBaseUrl: `http://${host}:${devuiPort}`,
        ollamaEndpoint: config.get("ollama.endpoint", "http://127.0.0.1:11434"),
    };
}
function updateStatusBar() {
    statusBarItem.text = "$(comment-discussion) BudAI";
    statusBarItem.tooltip = "Open BudAI";
    statusBarItem.show();
}
function isHttpEndpointReady(url) {
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
function getJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                }
                catch (error) {
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
async function waitForHttpEndpoint(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isHttpEndpointReady(url)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
}
function escapeHtmlAttribute(value) {
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
//# sourceMappingURL=extension.js.map