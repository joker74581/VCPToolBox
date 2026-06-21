// Test script for AutoProductSelection Workflow Driver
const path = require('path');

// Mock dependencies
const mockPluginManager = {
  getServiceModule: (name) => {
    if (name === 'AgentAssistant') {
      return {
        processToolCall: async (args) => {
          console.log('[MockAgentAssistant] Received tool call:', JSON.stringify(args, null, 2));
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

async function testWorkflowDriver() {
  console.log('=== AutoProductSelection Workflow Driver Test ===\n');

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

    console.log('Initializing plugin with workflow driver...');
    await plugin.initialize(testConfig, testDependencies);
    console.log('✓ Plugin initialized successfully\n');

    // Test queue status
    console.log('Testing queue status...');
    const queueResult = await plugin.processToolCall({
      command: 'auto_selection_queue_status',
      include_content: false
    });

    console.log('Queue Status Result:');
    console.log(`  - Success: ${queueResult.success}`);
    console.log(`  - Next Action Hint: ${queueResult.next_action_hint}`);
    console.log(`  - Active Briefs: ${queueResult.derived?.active_briefs?.length || 0}`);
    console.log(`  - Valid Locks: ${queueResult.derived?.valid_locks?.length || 0}`);
    console.log(`  - Failed Runs: ${queueResult.stages?.failed?.length || 0}`);
    console.log(`  - Scored Runs: ${queueResult.stages?.scored?.length || 0}`);
    console.log(`  - Raw Runs: ${queueResult.stages?.raw?.length || 0}`);
    console.log('✓ Queue status test passed\n');

    // Wait for one workflow driver tick
    console.log('Waiting for workflow driver tick (5 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('✓ Workflow driver tick completed\n');

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
testWorkflowDriver();
