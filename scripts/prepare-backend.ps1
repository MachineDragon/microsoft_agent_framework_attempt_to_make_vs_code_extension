$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'custom-ui\backend'
$target = Join-Path $root 'bundled-backend'
$agentSource = Join-Path $root 'agents'
$agentTarget = Join-Path $root 'bundled-agents'
$defaultAgents = @(
    'code_writer_agent',
    'data_analyst_agent',
    'devops_agent',
    'file_manager_agent',
    'planner_agent',
    'reviewer_agent',
    'shell_executor_agent',
    'web_researcher_agent'
)

if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
}

if (Test-Path $agentTarget) {
    Remove-Item $agentTarget -Recurse -Force
}

New-Item -ItemType Directory -Path $target | Out-Null
Copy-Item (Join-Path $source 'server.py') (Join-Path $target 'server.py')
Copy-Item (Join-Path $source 'ollama_stream.py') (Join-Path $target 'ollama_stream.py')
Copy-Item (Join-Path $source 'requirements.txt') (Join-Path $target 'requirements.txt')

New-Item -ItemType Directory -Path $agentTarget | Out-Null
foreach ($agent in $defaultAgents) {
    $sourcePath = Join-Path $agentSource $agent
    if (Test-Path $sourcePath) {
        Copy-Item $sourcePath (Join-Path $agentTarget $agent) -Recurse
    }
}
