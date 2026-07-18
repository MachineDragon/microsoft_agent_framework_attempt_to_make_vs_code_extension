# BudAI Privacy

BudAI is designed as a local-first VS Code extension for working with local models and local developer files.

## Local Processing

BudAI uses your configured local Ollama endpoint for model execution. Prompts, responses, model names, files, notes, and generated outputs are processed on your machine unless you explicitly use a feature that contacts an external web service.

## Local Storage

BudAI may store extension settings, service state, notes, tools, agents, and local backend environment files using VS Code storage locations. API keys and tokens entered in the BudAI settings UI are stored with VS Code SecretStorage and are passed to the local backend only at runtime.

## External Services

BudAI can open the Ollama download page and may use web search or web fetch features when you choose to use those features. Those requests are sent to the relevant external sites or providers.

## Contact

Use the support channel provided by the BudAI publisher for privacy or data handling questions.
