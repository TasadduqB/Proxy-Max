// Main Fleet Orchestrator for Android Multi-Agent System
// This file demonstrates how the multi-agent fleet operates with looping patterns

const LOOPING_AGENTS_CONFIG = require('./looping_agents_config');

class Agent {
  constructor(name, role, config) {
    this.name = name;
    this.role = role;
    this.config = config;
    this.state = {
      status: 'idle',
      currentTask: null,
      lastActivity: new Date(),
      messages: [],
      errors: []
    };
    this.loopInterval = null;
  }

  // Start the agent's looping behavior
  start() {
    console.log(`${this.name} (${this.role}) agent started`);
    this.state.status = 'active';

    // Start the main loop for this agent
    this.loopInterval = setInterval(() => {
      this.executeLoop();
    }, this.getLoopInterval() * 60 * 1000); // Convert minutes to milliseconds
  }

  // Stop the agent
  stop() {
    console.log(`${this.name} (${this.role}) agent stopped`);
    this.state.status = 'stopped';
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
    }
  }

  // Get the loop interval for this agent from config
  getLoopInterval() {
    const agentConfig = LOOPING_AGENTS_CONFIG.loops[this.role];
    return agentConfig ? agentConfig.intervalMinutes : 5;
  }

  // Execute the agent's loop actions
  async executeLoop() {
    if (this.state.status !== 'active') return;

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${this.name} executing loop...`);

    try {
      // Get the agent-specific configuration
      const agentConfig = LOOPING_AGENTS_CONFIG.loops[this.role];
      if (!agentConfig || !agentConfig.enabled) {
        console.log(`${this.name}: Agent disabled or not configured`);
        return;
      }

      // Execute each action in the agent's loop
      for (const action of agentConfig.actions) {
        await this.executeAction(action);
      }

      // Update last activity time
      this.state.lastActivity = new Date();

    } catch (error) {
      this.handleError(error);
    }
  }

  // Execute a specific action
  async executeAction(action) {
    console.log(`${this.name}: Executing action - ${action.description}`);

    // Simulate action execution based on type
    switch (action.type) {
      case 'statusCheck':
        await this.statusCheck(action);
        break;
      case 'taskPull':
        await this.taskPull(action);
        break;
      case 'codeImplementation':
        await this.codeImplementation(action);
        break;
      case 'commitAndPush':
        await this.commitAndPush(action);
        break;
      case 'ciTrigger':
        await this.ciTrigger(action);
        break;
      case 'buildMonitor':
        await this.buildMonitor(action);
        break;
      case 'testExecution':
        await this.testExecution(action);
        break;
      case 'techDebtReview':
        await this.techDebtReview(action);
        break;
      case 'architectureReview':
        await this.architectureReview(action);
        break;
      default:
        console.log(`${this.name}: Unknown action type - ${action.type}`);
        // Simulate generic action execution
        await this.sleep(1000); // 1 second delay
    }
  }

  // Action implementations (simplified for demonstration)
  async statusCheck(action) {
    console.log(`${this.name}: Checking status of agents: ${action.agentsToQuery.join(', ')}`);
    await this.sleep(500);
    // In real implementation, this would query other agents' status
    this.sendMessage('fleetStatusUpdate', {
      agent: this.name,
      status: this.state.status,
      timestamp: new Date()
    });
  }

  async taskPull(action) {
    console.log(`${this.name}: Pulling task from ${action.source}`);
    await this.sleep(1000);
    // Simulate pulling a task
    const task = {
      id: `TASK-${Math.floor(Math.random() * 1000)}`,
      title: `Implement feature ${Math.floor(Math.random() * 100)}`,
      priority: Math.random() > 0.5 ? 'high' : 'medium'
    };
    this.state.currentTask = task;
    console.log(`${this.name}: Pulled task - ${task.title}`);

    // Notify lead engineer if we got a task
    if (task) {
      this.sendMessage('taskAssigned', {
        agent: this.name,
        task: task
      });
    }
  }

  async codeImplementation(action) {
    if (!this.state.currentTask) {
      console.log(`${this.name}: No current task to implement`);
      return;
    }

    console.log(`${this.name}: Implementing task - ${this.state.currentTask.title}`);
    this.state.status = 'working';
    await this.sleep(3000); // Simulate 3 seconds of work
    this.state.status = 'active';

    // Mark task as implemented
    console.log(`${this.name}: Completed implementation of ${this.state.currentTask.title}`);
    this.sendMessage('taskCompleted', {
      agent: this.name,
      task: this.state.currentTask
    });

    // Clear current task after completion
    this.state.currentTask = null;
  }

  async commitAndPush(action) {
    console.log(`${this.name}: Committing and pushing code`);
    await this.sleep(2000);
    console.log(`${this.name}: Code committed and pushed to repository`);
    this.sendMessage('codePushed', {
      agent: this.name,
      timestamp: new Date()
    });
  }

  async ciTrigger(action) {
    console.log(`${this.name}: Triggering CI build`);
    await this.sleep(1000);
    console.log(`${this.name}: CI build triggered`);
    this.sendMessage('buildTriggered', {
      agent: this.name,
      timestamp: new Date()
    });
  }

  async buildMonitor(action) {
    console.log(`${this.name}: Monitoring build status`);
    await this.sleep(1500);
    // Simulate build completion
    const buildSuccess = Math.random() > 0.2; // 80% success rate
    this.sendMessage('buildCompleted', {
      agent: this.name,
      success: buildSuccess,
      timestamp: new Date()
    });

    if (buildSuccess) {
      console.log(`${this.name}: Build completed successfully`);
    } else {
      console.log(`${this.name}: Build failed - notifying team`);
      this.sendMessage('buildFailure', {
        agent: this.name,
        timestamp: new Date()
      });
    }
  }

  async testExecution(action) {
    console.log(`${this.name}: Executing test suites - ${action.testTypes.join(', ')}`);
    await this.sleep(4000); // Simulate test execution time

    // Simulate test results
    const testResults = {
      unit: { passed: Math.random() > 0.1, total: 50 },
      integration: { passed: Math.random() > 0.15, total: 20 },
      ui: { passed: Math.random() > 0.2, total: 10 }
    };

    const allPassed = Object.values(testResults).every(type => type.passed === type.total);
    this.sendMessage('testResults', {
      agent: this.name,
      results: testResults,
      passed: allPassed,
      timestamp: new Date()
    });

    if (allPassed) {
      console.log(`${this.name}: All tests passed`);
    } else {
      console.log(`${this.name}: Some tests failed`);
      this.sendMessage('testFailure', {
        agent: this.name,
        results: testResults,
        timestamp: new Date()
      });
    }
  }

  async techDebtReview(action) {
    console.log(`${this.name}: Reviewing technical debt`);
    await this.sleep(2000);
    console.log(`${this.name}: Technical debt review completed`);
    this.sendMessage('techDebtReviewed', {
      agent: this.name,
      itemsFound: Math.floor(Math.random() * 5),
      timestamp: new Date()
    });
  }

  async architectureReview(action) {
    console.log(`${this.name}: Reviewing architecture compliance`);
    await this.sleep(2500);
    console.log(`${this.name}: Architecture review completed`);
    this.sendMessage('architectureReviewed', {
      agent: this.name,
      concernsFound: Math.floor(Math.random() * 3),
      timestamp: new Date()
    });
  }

  // Send a message to other agents (simplified)
  sendMessage(messageType, data) {
    const message = {
      type: messageType,
      from: this.name,
      to: 'fleet', // In real implementation, this would route to specific agents
      data: data,
      timestamp: new Date()
    };

    this.state.messages.push(message);
    console.log(`${this.name}: Sent message - ${messageType}`);

    // In a real system, this would go through a message queue or event system
    // For demo, we'll just log it
  }

  // Handle errors
  handleError(error) {
    console.error(`${this.name}: Error in loop -`, error);
    this.state.errors.push({
      error: error.message,
      timestamp: new Date()
    });

    // Escalate if needed based on config
    const errorCount = this.state.errors.length;
    const errorThreshold = LOOPING_AGENTS_CONFIG.errorHandling.alertThresholds.consecutiveFailures;

    if (errorCount >= errorThreshold) {
      this.escalateError(error);
    }
  }

  // Escalate error to appropriate agent
  escalateError(error) {
    console.log(`${this.name}: Escalating error after ${this.state.errors.length} consecutive failures`);
    const escalationPath = LOOPING_AGENTS_CONFIG.errorHandling.escalationPath;

    // Find next agent in escalation path that's not myself
    const nextAgent = escalationPath.find(role => role !== this.role);
    if (nextAgent) {
      this.sendMessage('errorEscalation', {
        from: this.name,
        error: error.message,
        escalationLevel: this.state.errors.length,
        timestamp: new Date()
      });
      console.log(`${this.name}: Error escalated to ${nextAgent}`);
    }
  }

  // Utility sleep function
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get agent status
  getStatus() {
    return {
      name: this.name,
      role: this.role,
      status: this.state.status,
      currentTask: this.state.currentTask,
      lastActivity: this.state.lastActivity,
      messageCount: this.state.messages.length,
      errorCount: this.state.errors.length
    };
  }
}

// Fleet Orchestrator - manages all agents
class FleetOrchestrator {
  constructor() {
    this.agents = new Map();
    this.isRunning = false;
  }

  // Create and add an agent to the fleet
  addAgent(name, role) {
    const config = LOOPING_AGENTS_CONFIG.loops[role];
    if (!config) {
      throw new Error(`Unknown agent role: ${role}`);
    }

    const agent = new Agent(name, role, LOOPING_AGENTS_CONFIG);
    this.agents.set(name, agent);
    console.log(`Added ${name} (${role}) to the fleet`);
    return agent;
  }

  // Start all agents in the fleet
  startFleet() {
    if (this.isRunning) {
      console.log('Fleet is already running');
      return;
    }

    console.log('Starting Android Multi-Agent Fleet...');
    this.isRunning = true;

    // Start each agent
    for (const [name, agent] of this.agents) {
      agent.start();
    }

    console.log(`Fleet started with ${this.agents.size} agents`);
  }

  // Stop all agents in the fleet
  stopFleet() {
    if (!this.isRunning) {
      console.log('Fleet is not running');
      return;
    }

    console.log('Stopping Android Multi-Agent Fleet...');
    this.isRunning = false;

    // Stop each agent
    for (const [name, agent] of this.agents) {
      agent.stop();
    }

    console.log('Fleet stopped');
  }

  // Get status of all agents
  getFleetStatus() {
    const status = {
      fleetName: LOOPING_AGENTS_CONFIG.fleet.name,
      version: LOOPING_AGENTS_CONFIG.fleet.version,
      isRunning: this.isRunning,
      agentCount: this.agents.size,
      agents: Array.from(this.agents.values()).map(agent => agent.getStatus())
    };

    return status;
  }

  // Display fleet status in a readable format
  displayFleetStatus() {
    const status = this.getFleetStatus();
    console.log('\n=== Android Multi-Agent Fleet Status ===');
    console.log(`Fleet: ${status.fleetName} v${status.version}`);
    console.log(`Status: ${status.isRunning ? 'RUNNING' : 'STOPPED'}`);
    console.log(`Agents: ${status.agentCount}\n`);

    status.agents.forEach(agent => {
      console.log(`${agent.name} (${agent.role}):`);
      console.log(`  Status: ${agent.status}`);
      console.log(`  Current Task: ${agent.currentTask ? agent.currentTask.title : 'None'}`);
      console.log(`  Last Activity: ${agent.lastActivity}`);
      console.log(`  Messages: ${agent.messageCount} | Errors: ${agent.errorCount}\n`);
    });
  }
}

// Export classes for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Agent,
    FleetOrchestrator
  };
}

// Example usage if run directly
if (require.main === module) {
  console.log('Initializing Android Multi-Agent Fleet System...\n');

  // Create orchestrator
  const fleet = new FleetOrchestrator();

  // Add agents based on the defined roles
  fleet.addAgent('LeadEngineer-01', 'leadEngineer');
  fleet.addAgent('Developer-01', 'developer');
  fleet.addAgent('Developer-02', 'developer');
  fleet.addAgent('QA-01', 'qa');
  fleet.addAgent('Architect-01', 'architect');

  // Start the fleet
  fleet.startFleet();

  // Display initial status
  fleet.displayFleetStatus();

  // Run for a demonstration period, then stop
  setTimeout(() => {
    console.log('\n=== Stopping Fleet After Demonstration ===\n');
    fleet.stopFleet();

    // Display final status
    fleet.displayFleetStatus();

    console.log('\nAndroid Multi-Agent Fleet System demonstration completed.');
    process.exit(0);
  }, 30000); // Run for 30 seconds then stop
}