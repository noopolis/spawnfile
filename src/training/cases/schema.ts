import type { Dataset, DatasetRecord, RecordFields } from '../contracts/dataset.js';
import { bindingShape } from './turn-bindings.js';
import { checkShape, planShape } from './check-schema.js';
import { exclusive, fail, fields, json, object, oneOf, safePath, sequence, string, uniqueStrings } from './validation.js';

function selectors(value: unknown, path: string): void {
  sequence(value, path).forEach((entry, index) => {
    const location = `${path}[${index}]`;
    const file = object(entry, location);
    fields(file, ['resource', 'path', 'sha256'], location);
    string(file.resource, `${location}.resource`);
    safePath(file.path, `${location}.path`);
    if (!/^sha256:[a-f0-9]{64}$/.test(string(file.sha256, `${location}.sha256`))) {
      fail(`${location}.sha256`, 'expected sha256: followed by 64 lowercase hexadecimal digits');
    }
  });
}
function input(value: unknown, path: string, partial: boolean): void {
  const task = object(value, path);
  fields(task, ['prompt', 'data', 'files', 'message'], path);
  exclusive(task, ['prompt', 'message'], path, !partial);
  if (task.prompt !== undefined) string(task.prompt, `${path}.prompt`);
  if (task.files !== undefined) selectors(task.files, `${path}.files`);
  if (task.message !== undefined) {
    const message = object(task.message, `${path}.message`);
    fields(message, ['network', 'sender', 'target', 'text', 'json'], `${path}.message`);
    for (const name of ['network', 'sender', 'target']) string(message[name], `${path}.message.${name}`);
    exclusive(message, ['text', 'json'], `${path}.message`, true);
    if (message.text !== undefined) string(message.text, `${path}.message.text`);
    if (message.json !== undefined) object(message.json, `${path}.message.json`);
  }
}
export function recordFields(value: unknown, path: string, partial = true): RecordFields {
  const record = object(value, path);
  for (const key of ['context', 'setup']) {
    if (record[key] !== undefined) object(record[key], `${path}.${key}`);
  }
  if (record.input !== undefined) input(record.input, `${path}.input`, partial);
  if (record.reference !== undefined) {
    const reference = object(record.reference, `${path}.reference`);
    fields(reference, ['files', 'labels'], `${path}.reference`);
    if (reference.files !== undefined) selectors(reference.files, `${path}.reference.files`);
  }
  if (record.outputs !== undefined) {
    const outputs = object(record.outputs, `${path}.outputs`);
    for (const [name, location] of Object.entries(outputs)) {
      string(name, `${path}.outputs`);
      safePath(location, `${path}.outputs.${name}`);
    }
  }
  return record as RecordFields;
}
export function validateRecord(value: unknown, path: string, expanded = false): DatasetRecord {
  const record = object(value, path);
  fields(record, ['id', 'group', 'use', 'context', 'setup', 'input', 'reference', 'outputs',
    'turns', 'checks', 'stages'], path);
  string(record.id, `${path}.id`);
  if (record.group !== undefined) string(record.group, `${path}.group`);
  if (record.use !== undefined) uniqueStrings(record.use, `${path}.use`);
  exclusive(record, ['input', 'turns'], path, expanded);
  recordFields(record, path, !expanded);
  planShape(record, path);
  if (record.turns !== undefined) {
    const ids = new Set<string>();
    sequence(record.turns, `${path}.turns`).forEach((value, index) => {
      const turnPath = `${path}.turns[${index}]`;
      const turn = object(value, turnPath);
      fields(turn, ['id', 'input', 'after', 'bind', 'checks'], turnPath);
      const id = string(turn.id, `${turnPath}.id`);
      if (ids.has(id)) fail(turnPath, 'duplicate turn ID');
      if (turn.after !== undefined) {
        const after = object(turn.after, `${turnPath}.after`);
        fields(after, ['turn', 'outcome'], `${turnPath}.after`);
        if (!ids.has(string(after.turn, `${turnPath}.after.turn`))) fail(turnPath, 'after must name an earlier turn');
        oneOf(after.outcome, ['completed'], `${turnPath}.after.outcome`);
      }
      ids.add(id);
      input(turn.input, `${turnPath}.input`, false);
      if (turn.bind !== undefined) bindingShape(turn.bind, `${turnPath}.bind`);
      if (turn.checks !== undefined) planShape({ checks: turn.checks }, turnPath);
    });
  }
  return record as unknown as DatasetRecord;
}
export function validateDataset(value: unknown): Dataset {
  const dataset = object(json(value, '$'), '$');
  fields(dataset, ['schema', 'id', 'subject', 'setup', 'fixtures', 'checks', 'stages', 'live', 'records'], '$');
  oneOf(dataset.schema, ['paideia.dataset.v1'], '$.schema');
  string(dataset.id, '$.id');
  if (dataset.subject !== undefined) string(dataset.subject, '$.subject');
  if (dataset.setup !== undefined) object(dataset.setup, '$.setup');
  planShape(dataset, '$');
  if (dataset.fixtures !== undefined) {
    const fixtures = object(dataset.fixtures, '$.fixtures');
    for (const [name, fixture] of Object.entries(fixtures)) {
      const path = `$.fixtures.${name}`;
      string(name, path);
      fields(object(fixture, path), ['context', 'setup', 'input', 'reference', 'outputs'], path);
      recordFields(fixture, path);
    }
  }
  if (dataset.live !== undefined) {
    const live = object(dataset.live, '$.live');
    fields(live, ['checks'], '$.live');
    const ids = new Set<string>();
    sequence(live.checks, '$.live.checks').forEach((value, index) => {
      const path = `$.live.checks[${index}]`;
      const check = object(value, path);
      const id = string(check.id, `${path}.id`);
      if (ids.has(id)) fail(path, 'duplicate live check ID');
      ids.add(id);
      const { on, on_fail: action, ...criterion } = check;
      if (on !== 'event') {
        const trigger = object(on, `${path}.on`);
        fields(trigger, ['artifact'], `${path}.on`);
        string(trigger.artifact, `${path}.on.artifact`);
      }
      if (action !== undefined) oneOf(action, ['continue', 'stop'], `${path}.on_fail`);
      checkShape(criterion, path, true);
    });
  }
  const ids = new Set<string>();
  sequence(dataset.records, '$.records').forEach((value, index) => {
    const record = validateRecord(value, `$.records[${index}]`);
    if (ids.has(record.id)) fail(`$.records[${index}].id`, 'duplicate record ID');
    ids.add(record.id);
  });
  return dataset as unknown as Dataset;
}
