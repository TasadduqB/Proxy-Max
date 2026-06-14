// Looping Agent Configuration for Android Multi-Agent Fleet System
// This configuration implements the looping/recurring patterns for continuous development

const LOOPING_AGENTS_CONFIG = {
  // Global settings for the agent fleet
  fleet: {
    name: "Android Development Fleet",
    version: "1.0.0",
    orchestrator: "leadEngineer", // The agent that coordinates the fleet
    maxConcurrentLoops: 5,
    loopTimeoutMinutes: 30
  },

  // Define the looping patterns for each agent type
  loops: {
    // Lead Engineer Loop - Oversees the development process
    leadEngineer: {
      enabled: true,
      intervalMinutes: 15, // Check status every 15 minutes
      actions: [
        {
          type: "statusCheck",
          description: "Check overall fleet health and progress",
          agentsToQuery: ["developer", "qa", "architect"]
        },
        {
          type: "impedimentResolution",
          description: "Identify and resolve blockers",
          triggers: ["blockedTicket", "buildFailure", "testFailure"]
        },
        {
          type: "sprintPlanning",
          description: "Plan next development cycle",
          schedule: "weekly", // Every Monday at 9 AM
          time: "09:00"
        }
      ]
    },

    // Developer Loop - Continuous implementation and integration
    developer: {
      enabled: true,
      intervalMinutes: 5, // Check for new tasks frequently
      actions: [
        {
          type: "taskPull",
          description: "Pull next task from backlog",
          source: "jira", // or azure devops, github issues, etc.
          criteria: { status: "ready", assignee: null }
        },
        {
          type: "codeImplementation",
          description: "Implement assigned tasks",
          triggers: ["taskAssigned"]
        },
        {
          type: "commitAndPush",
          description: "Commit code and push to repository",
          triggers: ["codeComplete", "testsPass"],
          delayMinutes: 2
        },
        {
          type: "ciTrigger",
          description: "Trigger continuous integration build",
          triggers: ["codePushed"]
        }
      ]
    },

    // QA Agent Loop - Continuous testing and quality assurance
    qa: {
      enabled: true,
      intervalMinutes: 10, // Check for new builds/test requests
      actions: [
        {
          type: "buildMonitor",
          description: "Monitor CI/CD pipeline for new builds",
          triggers: ["buildCompleted"]
        },
        {
          type: "testExecution",
          description: "Execute automated test suites",
          triggers: ["buildReady", "deployToStaging"],
          testTypes: ["unit", "integration", "ui"]
        },
        {
          type: "regressionTesting",
          description: "Run regression tests on stable branches",
          schedule: "daily",
          time: "02:00" // 2 AM daily
        },
        {
          type: "releaseValidation",
          description: "Validate release candidates",
          triggers: ["releaseCandidateReady"]
        }
      ]
    },

    // Architect Loop - Continuous architectural oversight
    architect: {
      enabled: true,
      intervalMinutes: 30, // Less frequent but important checks
      actions: [
        {
          type: "techDebtReview",
          description: "Review and prioritize technical debt",
          schedule: "weekly",
          time: "10:00"
        },
        {
          type: "architectureReview",
          description: "Review recent code changes for architectural compliance",
          triggers: ["pullRequestOpened"],
          reviewTypes: ["newFeatures", "refactorings"]
        },
        {
          type: "technologyEvaluation",
          description: "Evaluate new technologies and frameworks",
          schedule: "monthly",
          time: "14:00"
        },
        {
          type: "scalabilityAnalysis",
          description: "Analyze system for scalability improvements",
          triggers: ["performanceIssue", "userGrowthAlert"]
        }
      ]
    }
  },

  // Communication patterns between agents
  communication: {
    // Message types that agents can send/receive
    messageTypes: {
      TASK_ASSIGNED: "taskAssigned",
      TASK_COMPLETED: "taskCompleted",
      BLOCKER_IDENTIFIED: "blockerIdentified",
      BUILD_COMPLETED: "buildCompleted",
      TEST_RESULTS: "testResults",
      DEPLOYMENT_READY: "deploymentReady",
      ARCHITECTURAL_CONCERN: "architecturalConcern",
      TECH_DEBT_IDENTIFIED: "techDebtIdentified"
    },

    // Channels for communication
    channels: {
      FLEET_ANNOUNCEMENTS: "fleet-announcements", // Broadcast to all agents
      DIRECT_MESSAGES: "direct-messages", // Agent-to-agent
      STATUS_UPDATES: "status-updates", // Periodic status sharing
      INCIDENTS: "incidents" // Urgent issues requiring immediate attention
    }
  },

  // Error handling and escalation
  errorHandling: {
    maxRetries: 3,
    retryDelayMinutes: 5,
    escalationPath: ["developer", "leadEngineer", "architect"], // Who to escalate to
    alertThresholds: {
      consecutiveFailures: 3,
      responseTimeMinutes: 15,
      blockedTimeMinutes: 60
    }
  },

  // Metrics and monitoring
  metrics: {
    enabled: true,
    collectionIntervalMinutes: 5,
    metricsToCollect: [
      "loopCompletionTime",
      "agentUtilization",
      "taskCycleTime",
      "defectRate",
      "buildSuccessRate",
      "deploymentFrequency"
    ],
    reporting: {
      dashboardUpdateInterval: "15m",
      alertRecipients: ["leadEngineer", "qa"],
      retrospectiveInterval: "weekly"
    }
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LOOPING_AGENTS_CONFIG;
}

// Example usage documentation:
// const fleetConfig = require('./looping_agents_config');
// // Initialize agent loops based on configuration
// // Each agent would have its own process that reads this config
// // and executes its defined loops at the specified intervals