const vscode = require("vscode");
const http = require("http");

const FRONTEND_URL = "http://localhost:3000";
const TARGET_FOLDER = "microsoft-agent-framework";

let opened = false;

function isTargetWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];

  return folders.some((folder) => {
    const path = folder.uri.fsPath.replace(/\\/g, "/").toLowerCase();
    return folder.name.toLowerCase() === TARGET_FOLDER && path.endsWith(`/${TARGET_FOLDER}`);
  });
}

function isFrontendReady() {
  return new Promise((resolve) => {
    const request = http.get(FRONTEND_URL, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });

    request.on("error", () => resolve(false));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function openFrontendWhenReady() {
  if (opened || !isTargetWorkspace()) {
    return;
  }

  const deadline = Date.now() + 60000;

  while (!opened && Date.now() < deadline) {
    if (await isFrontendReady()) {
      opened = true;
      await vscode.commands.executeCommand(
        "simpleBrowser.api.open",
        vscode.Uri.parse(FRONTEND_URL),
        { viewColumn: vscode.ViewColumn.Beside }
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function activate(context) {
  const disposable = vscode.commands.registerCommand(
    "microsoftAgentFrameworkAutoOpen.openFrontend",
    openFrontendWhenReady
  );

  context.subscriptions.push(disposable);
  openFrontendWhenReady();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};