/**
 * Workflow Engine — Coordinator Mode
 *
 * Goal-driven workflow generation. Converts a high-level goal into
 * a structured workflow with steps, instructions, and dependencies.
 *
 * Commands:
 *   generate  --goal "description" --dir <path> [--name <name>]  Generate workflow from goal
 *   plan      --goal "description"                                Generate plan only (no files)
 *   validate  --dir <path>                                        Validate workflow DAG
 *
 * Usage:
 *   node engine/coordinator.mjs generate --goal "Build a REST API" --dir ".workflows/my-api"
 */

import {
  readJSON, writeJSON, workflowPath, ensureDir,
  now, parseArgs, output, fail,
} from './utils.mjs';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

// ── Step Templates ────────────────────────────────────────

const STEP_TEMPLATES = {
  research: {
    name: 'research',
    artifact: null,  // handoff-only: conclusions transfer via handoff summary
    instruction: `# Research Phase

## Objective
Gather information and understand the requirements for this task.

## Tasks
1. Research existing solutions and best practices
2. Identify key components and dependencies
3. Document findings and key decisions

## Completion
This step has no artifact file. Your findings transfer automatically via the handoff system.
Ensure you clearly state your conclusions and key decisions before completing — they become the context for the next step.`,
    gate: { enabled: true, type: 'manual' },
    loop: { enabled: true, max_iterations: 2 },
  },

  design: {
    name: 'design',
    artifact: 'content',  // design docs need full content for review
    instruction: `# Design Phase

## Objective
Create a detailed design for the solution.

## Tasks
1. Define architecture and components
2. Create design diagrams if needed
3. Specify interfaces and data structures
4. Plan implementation steps

## Output
Write your design document to the artifact file. Include:
- System architecture
- Component diagrams
- Data flow
- API specifications (if applicable)`,
    gate: { enabled: true, type: 'review' },
    loop: { enabled: true, max_iterations: 2 },
    dependsOn: ['research'],
  },

  implement: {
    name: 'implement',
    artifact: 'reference',  // code lives in project, artifact is a file manifest
    instruction: `# Implementation Phase

## Objective
Build the solution according to the design.

## Tasks
1. Set up project structure
2. Implement core functionality
3. Write unit tests
4. Handle error cases

## Output
Write a file manifest to the artifact file listing what you created/modified:

| Action | Path | Description |
|--------|------|-------------|
| created | src/... | ... |
| modified | src/... | ... |

Include a summary of key implementation decisions and known limitations.`,
    gate: { enabled: true, type: 'review' },
    loop: { enabled: true, max_iterations: 3 },
    dependsOn: ['design'],
  },

  test: {
    name: 'test',
    artifact: null,  // test results come from gate command output
    instruction: `# Testing Phase

## Objective
Verify the implementation meets requirements.

## Tasks
1. Run unit tests
2. Perform integration testing
3. Check edge cases
4. Validate against requirements

## Completion
This step has no artifact file. Run the tests and let the gate command verify the results.
Report any issues found and fixed before completing.`,
    gate: { enabled: true, type: 'command' },
    loop: { enabled: true, max_iterations: 2 },
    dependsOn: ['implement'],
  },

  review: {
    name: 'review',
    artifact: null,  // review findings recorded in gate result
    instruction: `# Review Phase

## Objective
Final review and quality check.

## Tasks
1. Code review
2. Documentation review
3. Performance check
4. Security review

## Completion
This step has no artifact file. Conduct the review and report your findings.
The gate evaluation will capture the review result.`,
    gate: { enabled: true, type: 'manual' },
    loop: { enabled: false },
    dependsOn: ['test'],
  },

  deploy: {
    name: 'deploy',
    artifact: 'reference',  // deployment actions are in the project
    instruction: `# Deployment Phase

## Objective
Deploy the solution to target environment.

## Tasks
1. Prepare deployment package
2. Execute deployment steps
3. Verify deployment
4. Monitor initial operation

## Output
Write a deployment manifest to the artifact file:

| Action | Path / Target | Description |
|--------|--------------|-------------|
| deployed | ... | ... |
| configured | ... | ... |

Include verification results and rollback plan.`,
    gate: { enabled: true, type: 'review' },
    loop: { enabled: false },
    dependsOn: ['review'],
  },
};

// ── Goal Analysis ──────────────────────────────────────────

/**
 * Analyze goal complexity and suggest appropriate phases.
 * @param {string} goal - The goal description
 * @returns {object} Analysis result with suggested phases
 */
function analyzeGoal(goal) {
  const goalLower = goal.toLowerCase();
  
  // Detect goal type
  const isFeature = goalLower.includes('build') || 
                    goalLower.includes('create') || 
                    goalLower.includes('implement') ||
                    goalLower.includes('develop');
                    
  const isFix = goalLower.includes('fix') || 
                goalLower.includes('bug') || 
                goalLower.includes('issue') ||
                goalLower.includes('resolve');
                
  const isAnalysis = goalLower.includes('analyze') || 
                     goalLower.includes('research') || 
                     goalLower.includes('study') ||
                     goalLower.includes('investigate');
                     
  const isDeployment = goalLower.includes('deploy') || 
                       goalLower.includes('release') || 
                       goalLower.includes('publish');
                       
  const hasAPI = goalLower.includes('api') || goalLower.includes('rest');
  const hasUI = goalLower.includes('ui') || goalLower.includes('frontend') || goalLower.includes('interface');
  const hasBackend = goalLower.includes('backend') || goalLower.includes('server') || goalLower.includes('database');
  
  // Determine phases based on goal type
  let phases = [];
  
  if (isAnalysis) {
    phases = ['research'];
  } else if (isFix) {
    phases = ['research', 'implement', 'test'];
  } else if (isDeployment) {
    phases = ['research', 'deploy'];
  } else if (isFeature) {
    phases = ['research', 'design', 'implement', 'test', 'review'];
    if (isDeployment) phases.push('deploy');
  } else {
    // Default comprehensive workflow
    phases = ['research', 'design', 'implement', 'test'];
  }
  
  // Complexity estimation
  const complexity = {
    simple: phases.length <= 2,
    medium: phases.length > 2 && phases.length <= 4,
    complex: phases.length > 4,
  };
  
  // Detect keywords for instruction customization
  const keywords = [];
  if (hasAPI) keywords.push('api');
  if (hasUI) keywords.push('ui');
  if (hasBackend) keywords.push('backend');
  
  return {
    phases,
    complexity,
    keywords,
    detectedType: isFeature ? 'feature' : isFix ? 'fix' : isAnalysis ? 'analysis' : isDeployment ? 'deployment' : 'general',
  };
}

/**
 * Generate instruction content customized for the goal.
 * @param {string} template - Base template content
 * @param {string} goal - The goal description
 * @param {string} phase - Phase name
 * @returns {string} Customized instruction
 */
function customizeInstruction(template, goal, phase, keywords = []) {
  let instruction = template;
  
  // Add goal context at the top
  instruction = `# Goal: ${goal}\n\n---\n\n${template}`;
  
  // Add keyword-specific tasks
  if (keywords.includes('api')) {
    instruction += '\n\n## API-Specific Tasks\n- Define endpoints and schemas\n- Handle authentication/authorization\n- Document API contract';
  }
  if (keywords.includes('ui')) {
    instruction += '\n\n## UI-Specific Tasks\n- Design component structure\n- Handle state management\n- Ensure accessibility';
  }
  if (keywords.includes('backend')) {
    instruction += '\n\n## Backend-Specific Tasks\n- Design data models\n- Implement business logic\n- Handle error cases';
  }
  
  return instruction;
}

// ── Commands ──────────────────────────────────────────────

function generate(flags) {
  const { goal, dir, name } = flags;
  if (!goal) fail('--goal is required');
  if (!dir) fail('--dir is required');

  // Analyze goal
  const analysis = analyzeGoal(goal);
  const workflowName = name || goal.slice(0, 50).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  
  // Build steps
  const steps = [];
  const phaseToId = {};
  
  analysis.phases.forEach((phase, index) => {
    const template = STEP_TEMPLATES[phase] || STEP_TEMPLATES.research;
    const stepId = index + 1;
    phaseToId[phase] = stepId;
    
    // Resolve dependencies
    let dependsOn = [];
    if (template.dependsOn) {
      dependsOn = template.dependsOn
        .map(dep => phaseToId[dep])
        .filter(id => id !== undefined);
    }
    
    // Resolve artifact strategy from template
    let artifact;
    if (template.artifact === null) {
      artifact = null;
    } else if (template.artifact === 'reference') {
      artifact = { type: 'reference', manifest: `artifacts/${String(stepId).padStart(2, '0')}-${phase}.md` };
    } else {
      // 'content' or default
      artifact = `artifacts/${String(stepId).padStart(2, '0')}-${phase}.md`;
    }

    steps.push({
      id: stepId,
      name: phase,
      instruction: `steps/${String(stepId).padStart(2, '0')}-${phase}.md`,
      artifact,
      provider: null,
      dependsOn,
      gate: { ...template.gate },
      loop: { ...template.loop },
    });
  });

  // Build workflow
  const absDir = join(process.cwd(), dir);
  const wfPath = join(absDir, 'workflow.json');
  
  if (existsSync(wfPath)) {
    fail(`Workflow already exists at ${dir}. Use a different directory or delete existing workflow.`);
  }

  const stepStates = {};
  for (const step of steps) {
    stepStates[step.id] = { status: 'pending' };
  }

  const workflow = {
    name: workflowName,
    description: goal,
    created_at: now(),
    generated_by: 'coordinator',
    goal,
    
    steps,
    
    state: {
      status: 'ready',
      current_step: steps[0]?.id || null,
      completed_steps: [],
      step_states: stepStates,
      updated_at: now(),
    },
    
    hooks: {
      on_step_start: [],
      on_step_complete: [],
      on_gate_pass: [],
      on_gate_fail: [],
      on_workflow_complete: [],
      on_loop_start: [],
      on_loop_exit: [],
    },
    
    history: [
      { event: 'workflow_created', at: now(), source: 'coordinator', goal },
    ],
  };

  // Create directory structure
  ensureDir(absDir);
  ensureDir(join(absDir, 'steps'));
  ensureDir(join(absDir, 'artifacts'));
  ensureDir(join(absDir, 'gates'));
  
  // Write workflow.json
  writeJSON(wfPath, workflow);
  
  // Write instruction files
  for (const step of steps) {
    const template = STEP_TEMPLATES[step.name] || STEP_TEMPLATES.research;
    const instruction = customizeInstruction(
      template.instruction,
      goal,
      step.name,
      analysis.keywords
    );
    
    const instructionPath = join(absDir, step.instruction);
    writeFileSync(instructionPath, instruction, 'utf-8');
  }

  output({
    ok: true,
    workflow: workflowName,
    dir,
    goal,
    phases: analysis.phases,
    complexity: Object.keys(analysis.complexity).find(k => analysis.complexity[k]),
    detected_type: analysis.detectedType,
    steps: steps.map(s => ({
      id: s.id,
      name: s.name,
      dependsOn: s.dependsOn,
    })),
    dag: buildDAGVisualization(steps),
    message: `Generated workflow with ${steps.length} phases from goal`,
  });
}

function plan(flags) {
  const { goal } = flags;
  if (!goal) fail('--goal is required');

  const analysis = analyzeGoal(goal);
  
  // Build step plan without creating files
  const steps = analysis.phases.map((phase, index) => {
    const template = STEP_TEMPLATES[phase] || STEP_TEMPLATES.research;
    return {
      id: index + 1,
      name: phase,
      gate: template.gate.enabled ? template.gate.type : 'skip',
      loop: template.loop.enabled ? `max ${template.loop.max_iterations}` : 'disabled',
      dependsOn: template.dependsOn || [],
    };
  });

  output({
    ok: true,
    goal,
    analysis: {
      type: analysis.detectedType,
      complexity: Object.keys(analysis.complexity).find(k => analysis.complexity[k]),
      keywords: analysis.keywords,
    },
    plan: steps,
    dag: buildDAGVisualization(steps),
    recommendations: generateRecommendations(analysis),
  });
}

function validate(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  const wf = readJSON(workflowPath(dir));
  if (!wf) fail(`No workflow found at ${dir}`);

  const errors = [];
  const warnings = [];
  
  // Check for cycles in DAG
  const visited = new Set();
  const recursionStack = new Set();
  
  function hasCycle(stepId) {
    visited.add(stepId);
    recursionStack.add(stepId);
    
    const step = wf.steps.find(s => s.id === stepId);
    if (step?.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) return true;
        } else if (recursionStack.has(dep)) {
          return true;
        }
      }
    }
    
    recursionStack.delete(stepId);
    return false;
  }
  
  for (const step of wf.steps) {
    if (!visited.has(step.id)) {
      if (hasCycle(step.id)) {
        errors.push(`Cycle detected in dependency graph involving step ${step.id}`);
      }
    }
  }
  
  // Check for invalid dependencies
  const stepIds = new Set(wf.steps.map(s => s.id));
  for (const step of wf.steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          errors.push(`Step ${step.id} depends on non-existent step ${dep}`);
        }
      }
    }
  }
  
  // Check for orphan steps (no path from start)
  const reachableFromStart = new Set();
  function markReachable(stepId) {
    if (reachableFromStart.has(stepId)) return;
    reachableFromStart.add(stepId);
    
    for (const step of wf.steps) {
      if (step.dependsOn?.includes(stepId)) {
        markReachable(step.id);
      }
    }
  }
  
  // Start from steps with no dependencies
  const startSteps = wf.steps.filter(s => !s.dependsOn || s.dependsOn.length === 0);
  for (const step of startSteps) {
    markReachable(step.id);
  }
  
  for (const step of wf.steps) {
    if (!reachableFromStart.has(step.id)) {
      warnings.push(`Step ${step.id} (${step.name}) is not reachable from any starting step`);
    }
  }
  
  // Check for parallel opportunities
  const parallelOpportunities = [];
  for (const step of wf.steps) {
    const siblings = wf.steps.filter(s => 
      s.id !== step.id && 
      JSON.stringify(s.dependsOn || []) === JSON.stringify(step.dependsOn || [])
    );
    if (siblings.length > 0) {
      const group = [step.id, ...siblings.map(s => s.id)].sort((a, b) => a - b);
      const key = group.join(',');
      if (!parallelOpportunities.find(p => p.join(',') === key)) {
        parallelOpportunities.push(group);
      }
    }
  }

  output({
    ok: errors.length === 0,
    workflow: wf.name,
    valid: errors.length === 0,
    errors,
    warnings,
    dag_analysis: {
      total_steps: wf.steps.length,
      start_steps: startSteps.map(s => s.id),
      reachable_steps: reachableFromStart.size,
      parallel_groups: parallelOpportunities,
    },
    message: errors.length === 0 
      ? 'Workflow DAG is valid'
      : `Found ${errors.length} error(s) in workflow DAG`,
  });
}

// ── Helpers ───────────────────────────────────────────────

function buildDAGVisualization(steps) {
  const lines = ['```'];
  for (const step of steps) {
    const deps = step.dependsOn || [];
    if (deps.length === 0) {
      lines.push(`[${step.id}] ${step.name}`);
    } else {
      const depStr = deps.map(d => `[${d}]`).join(' → ');
      lines.push(`${depStr} → [${step.id}] ${step.name}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

function generateRecommendations(analysis) {
  const recs = [];
  
  if (analysis.complexity.complex) {
    recs.push('Consider breaking down into multiple smaller workflows');
  }
  
  if (analysis.keywords.includes('api')) {
    recs.push('Add API documentation step after implementation');
  }
  
  if (analysis.keywords.includes('ui')) {
    recs.push('Consider adding a design review gate');
  }
  
  if (analysis.detectedType === 'fix') {
    recs.push('Add root cause analysis in research phase');
    recs.push('Include regression test in test phase');
  }
  
  return recs;
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case 'generate': generate(flags); break;
  case 'plan':     plan(flags); break;
  case 'validate': validate(flags); break;
  default:         fail(`Unknown command: ${command}. Use generate|plan|validate`);
}
