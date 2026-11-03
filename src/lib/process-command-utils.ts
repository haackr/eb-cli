import * as fs from 'fs';
import { Flags } from '@oclif/core';
import * as eb from './eb-puppetmaster/index.js';
import {
  listProcessInstances,
  parseGuid,
  type FieldInputValue,
} from './eb-puppetmaster/process-instance.js';

/** Flags shared by commands that write process fields. */
export const fieldFlags = {
  field: Flags.string({
    char: 'F',
    description:
      'Field to set as "Label=value" (repeatable). Label match is case-insensitive; a DataFieldID GUID also works. Use "a; b" for multi-value fields and an empty value to clear.',
    multiple: true,
  }),
  fields: Flags.string({
    description: 'Fields as a JSON object ({"Label": "value"}) or @path/to/file.json',
  }),
};

export function parseFieldInputs(
  fieldFlagsValue: string[] | undefined,
  fieldsJson: string | undefined,
): Record<string, FieldInputValue> {
  const out: Record<string, FieldInputValue> = {};
  if (fieldsJson) {
    const raw = fieldsJson.startsWith('@')
      ? fs.readFileSync(fieldsJson.slice(1), 'utf8')
      : fieldsJson;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--fields must be a JSON object of {"Label": value}');
    }
    Object.assign(out, parsed);
  }
  for (const entry of fieldFlagsValue ?? []) {
    const i = entry.indexOf('=');
    if (i <= 0) throw new Error(`--field must look like "Label=value" (got "${entry}")`);
    out[entry.slice(0, i).trim()] = entry.slice(i + 1);
  }
  return out;
}

/** Resolves an instance given as a GUID, or as its name ("MPA - 2", open or closed) within --project. */
export async function resolveInstanceId(
  base: { env: eb.Environment; cookies: any[] },
  instance: string,
  project: string | undefined,
): Promise<string> {
  const id = parseGuid(instance);
  if (id) return id;
  if (!project) {
    throw new Error(`"${instance}" is not an instance ID; pass --project to look it up by name`);
  }
  const norm = (s: string) =>
    s
      .replace(/\s+/g, ' ')
      .replace(/\s*-\s*/g, ' - ')
      .trim()
      .toLowerCase();
  const find = async (status: 'open' | 'all') =>
    (await listProcessInstances({ ...base, project, status })).instances.find(
      (i) => norm(i.name) === norm(instance),
    );
  // Open instances first (one page load); closed/draft ones need the state filter.
  const hit = (await find('open')) ?? (await find('all'));
  if (!hit) throw new Error(`No instance named "${instance}" in project "${project}"`);
  return hit.instanceId;
}

const projectDescription = 'Project name (case-insensitive, unique partial match) or PortalID GUID';
export const projectFlag = Flags.string({ char: 'P', description: projectDescription });
export const requiredProjectFlag = Flags.string({
  char: 'P',
  description: projectDescription,
  required: true,
});
