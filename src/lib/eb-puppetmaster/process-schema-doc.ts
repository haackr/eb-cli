import type {
  LayoutFieldAccess,
  ProcessSchema,
  ProcessWorkflowStepSchema,
} from './process-schema.js';

/** Escapes a value for a Markdown table cell. */
const cell = (v: string | undefined | null) =>
  (v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/** Inline code that survives backticks inside the value. */
const code = (v: string) => {
  const fence = v.includes('`') ? '``' : '`';
  return `${fence}${v.includes('`') ? ` ${v} ` : v}${fence}`;
};

/** Escapes text for a quoted Mermaid label. */
const mermaidText = (v: string) =>
  v.replace(/"/g, '#quot;').replace(/[<>]/g, (c) => (c === '<' ? '#lt;' : '#gt;'));

const STEP_SHAPES: Record<string, [string, string]> = {
  Start: ['([', '])'],
  Finish: ['([', '])'],
  Conditional: ['{', '}'],
  Automated: ['[[', ']]'],
  Spawn: ['[/', '/]'],
};

/**
 * Orders steps the way a reader follows the workflow: breadth-first from Start along action
 * targets, then any steps not reachable from Start, with Finish steps last.
 */
export function orderWorkflowSteps(
  steps: ProcessWorkflowStepSchema[],
): ProcessWorkflowStepSchema[] {
  const byId = new Map(steps.filter((s) => s.id).map((s) => [s.id!.toLowerCase(), s]));
  const seen = new Set<ProcessWorkflowStepSchema>();
  const ordered: ProcessWorkflowStepSchema[] = [];
  const queue = steps.filter((s) => s.type === 'Start');
  while (queue.length) {
    const step = queue.shift()!;
    if (seen.has(step)) continue;
    seen.add(step);
    ordered.push(step);
    for (const a of step.actionDetails ?? []) {
      const next = a.toStepId ? byId.get(a.toStepId.toLowerCase()) : undefined;
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  const rest = steps.filter((s) => !seen.has(s));
  const all = [...ordered, ...rest];
  return [...all.filter((s) => s.type !== 'Finish'), ...all.filter((s) => s.type === 'Finish')];
}

/** Mermaid flowchart of the workflow: one node per step, one labeled edge per connected action. */
export function workflowMermaid(steps: ProcessWorkflowStepSchema[]): string {
  const ordered = orderWorkflowSteps(steps);
  const nodeId = new Map(ordered.map((s, i) => [s, `s${i}`]));
  const idByStepId = new Map(
    ordered.filter((s) => s.id).map((s) => [s.id!.toLowerCase(), nodeId.get(s)!]),
  );
  const lines = ['flowchart TD'];
  for (const s of ordered) {
    const [open, close] = STEP_SHAPES[s.type] ?? ['[', ']'];
    lines.push(`  ${nodeId.get(s)}${open}"${mermaidText(s.name)}"${close}`);
  }
  for (const s of ordered) {
    for (const a of s.actionDetails ?? []) {
      const to = a.toStepId ? idByStepId.get(a.toStepId.toLowerCase()) : undefined;
      if (!to) continue;
      lines.push(`  ${nodeId.get(s)} -->|"${mermaidText(a.name)}"| ${to}`);
    }
  }
  return lines.join('\n');
}

const ACCESS_LABEL: Record<LayoutFieldAccess, string> = {
  required: 'Required',
  editable: 'Edit',
  readonly: 'Read',
  hidden: '–',
};

/** Human-readable Markdown documentation of a process schema (for `process inspect --markdown`). */
export function processSchemaToMarkdown(schema: ProcessSchema): string {
  const out: string[] = [];
  const title = schema.prefix ? `${schema.name} (${schema.prefix})` : schema.name;
  out.push(`# ${title}`, '');
  if (schema.description) out.push(schema.description, '');

  const facts: Array<[string, string | undefined]> = [
    ['Process ID', schema.processId ?? schema.processTypeId],
    ['Variable name', schema.variableName],
    ['Project assignment', schema.projectAssignment],
    ['Active', schema.active],
    ['Workflow', schema.workflow],
  ];
  out.push('| | |', '| --- | --- |');
  for (const [k, v] of facts) if (v) out.push(`| ${k} | ${cell(v)} |`);
  out.push('');
  if (schema.cachedAt) out.push(`_Read from e-Builder Setup; cached ${schema.cachedAt}._`, '');

  // Workflow
  const steps = orderWorkflowSteps(schema.workflowSteps);
  out.push('## Workflow', '');
  if (steps.length === 0) {
    out.push('_No workflow steps were read._', '');
  } else {
    if (schema.workflows && schema.workflows.length > 1) {
      const others = schema.workflows.filter((w) => w.name !== schema.workflow).map((w) => w.name);
      out.push(`Other workflows (not shown): ${others.join(', ')}.`, '');
    }
    out.push('```mermaid', workflowMermaid(schema.workflowSteps), '```', '');

    for (const [i, s] of steps.entries()) {
      out.push(`### ${i + 1}. ${s.name}`, '');
      const meta: string[] = [`- **Type:** ${s.type}`];
      if (s.condition) meta.push(`- **Condition:** ${code(s.condition)}`);
      if (s.spawnProcess) meta.push(`- **Spawns:** ${s.spawnProcess}`);
      if (s.actors?.length) meta.push(`- **Actors:** ${s.actors.join('; ')}`);
      if (s.notifyRoles?.length) meta.push(`- **Notifies:** ${s.notifyRoles.join('; ')}`);
      if (s.actorLayout) {
        const same = !s.nonActorLayout || s.nonActorLayout === s.actorLayout;
        meta.push(
          same
            ? `- **Layout:** ${s.actorLayout}`
            : `- **Layout:** ${s.actorLayout} (actor), ${s.nonActorLayout} (others)`,
        );
      }
      out.push(...meta, '');

      const actions = s.actionDetails ?? s.actions.map((name) => ({ name }));
      if (actions.length === 0) continue;
      const isConditional = s.type === 'Conditional';
      out.push(
        isConditional
          ? '| Branch | Goes to | Sets fields |'
          : '| Action | Goes to | Status | Sets fields |',
        isConditional ? '| --- | --- | --- |' : '| --- | --- | --- | --- |',
      );
      for (const a of actions) {
        const d = a as NonNullable<ProcessWorkflowStepSchema['actionDetails']>[number];
        const name = cell(d.name) + (d.requireComments ? ' (comment required)' : '');
        const to = d.to ? cell(d.to) : '_not connected_';
        const sets = (d.assignments ?? []).map((f) => cell(f.field)).join(', ');
        out.push(
          isConditional
            ? `| ${name} | ${to} | ${sets} |`
            : `| ${name} | ${to} | ${cell(d.status)} | ${sets} |`,
        );
      }
      out.push('');

      for (const a of actions) {
        const d = a as NonNullable<ProcessWorkflowStepSchema['actionDetails']>[number];
        if (d.additionalRoles?.length) {
          out.push(`**${d.name}** can add: ${d.additionalRoles.join('; ')}`, '');
        }
        if (d.assignments?.length) {
          out.push(`**${d.name}** sets:`, '');
          for (const f of d.assignments) out.push(`- ${f.field} = ${code(f.expression)}`);
          out.push('');
        }
      }
    }
  }

  // Data fields
  out.push('## Data fields', '');
  if (schema.dataFields.length === 0) {
    out.push('_No data fields were read._', '');
  } else {
    out.push(
      '| Label | Variable name | Type | Required | Permission |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const f of schema.dataFields) {
      out.push(
        `| ${cell(f.name)} | ${cell(f.variableName)} | ${cell(f.type)} | ${f.required ? 'Yes' : ''} | ${cell(f.permission)} |`,
      );
    }
    out.push('');
  }

  // Layout matrix: one row per field, one column per layout.
  // Layouts in Manage Layouts order (the matrix is filled in fetch-completion order).
  const gridOrder = (schema.layouts ?? []).map((l) => l.name);
  const layoutNames = Object.keys(schema.layoutMatrix).sort((a, b) => {
    const ia = gridOrder.indexOf(a);
    const ib = gridOrder.indexOf(b);
    if (ia !== ib && ia >= 0 && ib >= 0) return ia - ib;
    if (ia < 0 !== ib < 0) return ia < 0 ? 1 : -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  if (layoutNames.length) {
    out.push('## Field access by layout', '');
    out.push(
      'Required = must be filled in, Edit = editable, Read = read-only, – = not on the layout.',
      '',
    );
    out.push(
      `| Field | ${layoutNames.map(cell).join(' | ')} |`,
      `| --- | ${layoutNames.map(() => '---').join(' | ')} |`,
    );
    const fieldNames = schema.dataFields.length
      ? schema.dataFields.map((f) => f.name)
      : [...new Set(layoutNames.flatMap((l) => Object.keys(schema.layoutMatrix[l] ?? {})))];
    for (const f of fieldNames) {
      const row = layoutNames.map((l) => ACCESS_LABEL[schema.layoutMatrix[l]?.[f] ?? 'hidden']);
      out.push(`| ${cell(f)} | ${row.join(' | ')} |`);
    }
    out.push('');
  }

  if (schema.warnings?.length) {
    out.push('## Warnings', '', ...schema.warnings.map((w) => `- ${w}`), '');
  }
  return out.join('\n');
}
