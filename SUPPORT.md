# BudAI Support

## First Checks

1. Install Ollama and confirm it is running.
2. Run `ollama list` to confirm at least one model is installed.
3. In VS Code, run **BudAI: Check Local Services** from the Command Palette.
4. If an agent says it needs a model, open that agent's configuration and select one of your local Ollama models.
5. If the backend fails to start, confirm Python 3.10 or newer is available on your PATH or set `budai.backend.pythonPath`.

## Logs

BudAI writes service startup and health information to the **BudAI** output channel in VS Code.

## Common Issues

- First launch can take several minutes while BudAI creates a Python virtual environment and installs backend dependencies.
- Corporate firewalls or restricted Python environments can block dependency installation.
- Ollama must be installed separately and must be reachable at the configured `budai.ollama.endpoint`.

## Publisher Support

For publisher support, contact **budai.support@gmail.com** or visit **https://machinedragon.github.io/budai/#/services**.
