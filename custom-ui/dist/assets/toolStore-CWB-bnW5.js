import{k as n,F as d,G as c,H as p}from"./index-DwIu_5gj.js";const f=n("Code",[["polyline",{points:"16 18 22 12 16 6",key:"z7tu5w"}],["polyline",{points:"8 6 2 12 8 18",key:"1eg1df"}]]);const m=n("WandSparkles",[["path",{d:"m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72",key:"ul74o6"}],["path",{d:"m14 7 3 3",key:"1r5n42"}],["path",{d:"M5 6v4",key:"ilb8ba"}],["path",{d:"M19 14v4",key:"blhpug"}],["path",{d:"M10 2v2",key:"7u0qdc"}],["path",{d:"M7 8H3",key:"zfb6yr"}],["path",{d:"M21 16h-4",key:"1cnmox"}],["path",{d:"M11 3H9",key:"1obp7u"}]]),i=[{id:"code_interpreter",name:"Ollama Code Interpreter",description:"Local @ai_function adapter that lets an Ollama agent execute short Python scripts through the custom backend.",code:`from agent_framework import ai_function

  @ai_function
  def code_interpreter(code: str) -> str:
    """Execute a short Python script locally and return stdout, stderr, and the exit code."""
    # Generated agent folders include the full local executor implementation.
    ...
`,created_at:new Date().toISOString(),isDefault:!0},{id:"web_search",name:"HostedWebSearchTool",description:"Official hosted provider tool marker for web search; local Ollama agents use the custom backend web-search route instead.",code:`from agent_framework import HostedWebSearchTool

tool = HostedWebSearchTool()

# With optional location context:
# tool = HostedWebSearchTool(
#     additional_properties={"user_location": {"city": "Seattle", "country": "US"}}
# )
`,created_at:new Date().toISOString(),isDefault:!0},{id:"file_search",name:"HostedFileSearchTool",description:"Official hosted provider tool marker for provider-indexed files/vector stores; local Ollama needs a custom retrieval adapter.",code:`from agent_framework import HostedFileSearchTool

tool = HostedFileSearchTool()

# With vector-store inputs and max results:
# tool = HostedFileSearchTool(inputs=[{"vector_store_id": "vs_123"}], max_results=10)
`,created_at:new Date().toISOString(),isDefault:!0},{id:"hosted_mcp",name:"HostedMCPTool",description:"Official hosted MCP definition managed by a capable AI service; local Ollama needs a local MCP adapter.",code:`from agent_framework import HostedMCPTool

tool = HostedMCPTool(
    name="my_mcp_tool",
    url="https://example.com/mcp",
)

# Optional: approval_mode, allowed_tools, headers, and description.
`,created_at:new Date().toISOString(),isDefault:!0}],h=d()(c((a,o)=>({tools:i,addTool:e=>{a(t=>({tools:[...t.tools,e]}))},deleteTool:e=>{if(o().getTool(e)?.isDefault){console.warn("Cannot delete default tools");return}a(s=>({tools:s.tools.filter(r=>r.id!==e)}))},updateTool:(e,t)=>{if(o().getTool(e)?.isDefault){console.warn("Cannot update default tools");return}a(r=>({tools:r.tools.map(l=>l.id===e?{...l,...t}:l)}))},getTool:e=>o().tools.find(t=>t.id===e),getDefaultTools:()=>o().tools.filter(e=>e.isDefault),getUserTools:()=>o().tools.filter(e=>!e.isDefault)}),{name:"tool-storage",storage:p(),merge:(a,o)=>({...o,tools:[...i,...a?.tools?.filter(e=>!e.isDefault)||[]]})}));export{f as C,m as W,h as u};
