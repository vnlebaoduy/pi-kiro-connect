// ABOUTME: Byte-exact fixture of the observed XML-dialect tool-call leak.
// ABOUTME: Shared by invoke-tool-parser and stream end-to-end regressions.

/**
 * Verbatim leak payload from
 * `~/.kermes/sessions/b72e20b9a9e8/kanban-task-1786606873-6ee4-merge-2.jsonl`
 * record 279 — an assistant record with `stopReason: "stop"`, zero `toolCall`
 * blocks, and this text. The command embeds single quotes, double quotes, a `>`
 * redirect and a multi-line `python3 -c` program, so byte-exact preservation is
 * the regression that matters most: a corrupted recovery would *execute*
 * something the model never wrote, which is worse than not recovering at all.
 */
export const RECORD_279_COMMAND = `cd /workplace/sauhsoj/kermes/worktrees/happy-toucan/src/KermesAgent && timeout 120 mcscli curl -s -L 'https://code.amazon.com/reviews/CR-296790373/revisions/1?format=json' 2>/dev/null > /tmp/cr3.json; python3 -c "
import json
d=json.load(open('/tmp/cr3.json'))
r=d['revision']['cr_revision']
desc=r.get('description') or ''
local=open('.agents/scratchpad/cr-description.md').read()
print('remote desc bytes:', len(desc.encode()))
print('local  desc bytes:', len(local.encode()))
print('IDENTICAL:', desc==local)
print('glued bullets remote:', desc.count(';- '))
print('status:', r.get('status'), '| diff_source:', json.dumps(r.get('diff_source')))
print('summary:', r.get('summary'))
"`;

export const RECORD_279_SUMMARY = "read back description to confirm the fix landed";

export const RECORD_279_TEXT = `<invoke name="shell">
<parameter name="command">${RECORD_279_COMMAND}</parameter>
<parameter name="summary">${RECORD_279_SUMMARY}</parameter>
</invoke>`;
