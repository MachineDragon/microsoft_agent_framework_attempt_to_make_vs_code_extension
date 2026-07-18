# Temporary file with correct orchestration implementation
# This shows the correct way to use Microsoft Agent Framework workflows

"""
The correct API is:
- ConcurrentBuilder - for parallel execution
- SequentialBuilder - for pipeline execution  
- GroupChatBuilder - for round-robin group chat

NOT "Orchestration" classes - those don't exist!

Usage:
    from agent_framework import ConcurrentBuilder, SequentialBuilder, GroupChatBuilder
    from agent_framework import InProcessRuntime, RoundRobinGroupChatManager
    
    # Concurrent
    workflow = ConcurrentBuilder().participants(agents).build()
    
    # Sequential
    workflow = SequentialBuilder().participants(agents).build()
    
    # Group Chat
    workflow = (
        GroupChatBuilder()
        .participants(agents)
        .with_manager(RoundRobinGroupChatManager(max_rounds=5))
        .build()
    )
    
    # Execute
    runtime = InProcessRuntime()
    result = await workflow.invoke(task="user message", runtime=runtime)
    final_value = await result.get(timeout=60)
    await runtime.stop_when_idle()
"""
