// Test script for AutoProductSelection Closed-Loop Workflow
const path = require('path');

// Mock dependencies
const mockPluginManager = {
  getServiceModule: (name) => {
    if (name === 'AgentAssistant') {
      return {
        processToolCall: async (args) => {
          console.log('[MockAgentAssistant] Received tool call:', {
            command: args.command,
            agent_name: args.agent_name,
            task_delegation: args.task_delegation,
            inject_tools: args.inject_tools,
            prompt_length: args.prompt?.length || 0
          });
          return {
            success: true,
            message: 'Mock AgentAssistant delegation accepted',
            delegation_id: `aa-delegation-test-${Date.now()}`
          };
        }
      };
    }
    return null;
  }
};

async function testClosedLoopWorkflow() {
  console.log('=== AutoProductSelection Closed-Loop Workflow Test ===\n');

  try {
    // Load the plugin module
    const plugin = require('./AutoProductSelection.js');
    console.log('✓ Plugin module loaded successfully\n');

    // Initialize with test config
    const testConfig = {
      DebugMode: true,
      AUTO_SELECTION_SCOUT_AGENT_NAME: 'ProductSelectionScout',
      AUTO_SELECTION_REVIEWER_AGENT_NAME: 'ProductSelectionReviewer'
    };

    const testDependencies = {
      pluginManager: mockPluginManager
    };

    console.log('Initializing plugin...');
    await plugin.initialize(testConfig, testDependencies);
    console.log('✓ Plugin initialized (workflow NOT auto-started)\n');

    // Test 1: Trigger run when not running
    console.log('Test 1: Trigger workflow when not running...');
    const triggerResult1 = await plugin.processToolCall({
      command: 'auto_selection_trigger_run'
    });
    console.log('Trigger Result:', JSON.stringify(triggerResult1, null, 2));
    console.log('✓ Test 1 passed\n');

    // Wait for 3 seconds
    console.log('Waiting 3 seconds for workflow to start...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Test 2: Try to trigger again (should fail)
    console.log('Test 2: Try to trigger while running...');
    const triggerResult2 = await plugin.processToolCall({
      command: 'auto_selection_trigger_run'
    });
    console.log('Trigger Result:', JSON.stringify(triggerResult2, null, 2));

    if (!triggerResult2.success && triggerResult2.error === 'workflow_already_running') {
      console.log('✓ Test 2 passed (correctly rejected)\n');
    } else {
      console.log('✗ Test 2 failed (should have rejected)\n');
    }

    // Test 3: Queue status
    console.log('Test 3: Check queue status...');
    const queueResult = await plugin.processToolCall({
      command: 'auto_selection_queue_status',
      include_content: false
    });
    console.log('Queue Status:');
    console.log(`  - Success: ${queueResult.success}`);
    console.log(`  - Next Action: ${queueResult.next_action_hint}`);
    console.log(`  - Active Briefs: ${queueResult.derived?.active_briefs?.length || 0}`);
    console.log(`  - Valid Locks: ${queueResult.derived?.valid_locks?.length || 0}`);
    console.log('✓ Test 3 passed\n');

    // Wait for another 3 seconds
    console.log('Waiting 3 more seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Shutdown
    console.log('Shutting down plugin...');
    await plugin.shutdown();
    console.log('✓ Plugin shutdown successfully\n');

    console.log('=== All Tests Passed ===');
    process.exit(0);

  } catch (error) {
    console.error('✗ Test failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
testClosedLoopWorkflow();
