# BudAI

BudAI brings local AI agents, chat, tools, and workflow building into Visual Studio Code using Ollama and open-source models.

## Features

- Chat with local Ollama models from inside VS Code.
- Open BudAI from the Activity Bar.
- Check local service health from the BudAI sidebar.
- Build with agents, tools, notes, files, data workflows, and model utilities from one interface.
- Use BudAI as a free preview while installation, local setup, and Ollama workflows are tested.

## Requirements

- Visual Studio Code 1.96 or newer.
- Python 3.11 or newer available on your PATH, or configured with `budai.backend.pythonPath`.
- Ollama installed locally for model execution.
- At least one local Ollama model, such as `qwen2.5:7b` or `qwen2.5-coder:7b`.

BudAI creates its own Python virtual environment in VS Code global storage the first time it starts the bundled backend. This can take a few minutes on first launch.

## Getting Started

1. Install Ollama from https://ollama.com/download.
2. Install BudAI in VS Code.
3. Click the BudAI icon in the Activity Bar.
4. Select **Open BudAI**.
5. Select a local model for direct chat or configure a model for an agent when prompted.

## Settings

- `budai.backend.pythonPath`: Python executable used to create BudAI's backend environment.
- `budai.backend.autoStart`: Automatically start the bundled backend when BudAI opens.
- `budai.ollama.endpoint`: Local Ollama API endpoint.

## Privacy

BudAI is designed for local-first AI workflows. Local prompts, files, models, and generated content are processed through your configured local services unless you explicitly use a feature that reaches an external web service.

API keys entered in BudAI settings are stored with VS Code SecretStorage and are not packaged into the extension.

## Support

Use the BudAI output channel in VS Code for service logs and run **BudAI: Check Local Services** from the Command Palette for troubleshooting. For support, contact **budai.support@gmail.com** or visit **https://machinedragon.github.io/budai/#/services**.
