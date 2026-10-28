import { describe, expect, it } from 'bun:test';
import { parseAgentXml } from '../../src/sdk/parser.js';

describe('summary field boundaries', () => {
  it('rejects a wrong learned closing tag even when request and completed survive', () => {
    const result = parseAgentXml(`<summary>
      <request>Investigate a submission failure</request>
      <investigated>Read the allocation code</investigated>
      <learned>The counter can assign the same worker twice</investigated>
      <completed>Identified the collision; no code was changed</completed>
      <next_steps>Ask the owner to fix allocation</next_steps>
    </summary>`);
    expect(result).toEqual({ valid: false });
  });

  it('rejects cascading missing and mismatched boundaries instead of storing only notes', () => {
    const result = parseAgentXml(`<summary>
      <request>Publish a route and verify it</request>
      <investigated>The probe returned 429</learned>
      The route was published; verification is still incomplete</completed>
      <next_steps>Wait for quota investigation</next_steps>
      <notes>Key usability remains unverified</notes>
    </summary>`);
    expect(result).toEqual({ valid: false });
  });

  it('rejects unclosed, stray, crossed, duplicate and nested schema fields', () => {
    for (const body of [
      '<request>Review</request><learned>Missing closer',
      '<request>Review</request></learned>',
      '<learned>Finding<completed>Work</learned></completed>',
      '<request>First request</request><request>Second request</request>',
      '<request>Review<learned>Finding</learned></request>',
      '<request>Review</request><learned source="other">Finding</learned>',
      '<request>Review</request><summary><notes>Second block</notes></summary>',
      '<request>Review</request><learned incomplete',
      '<request>Review</request><learned',
      '<request>Review</request></learned incomplete',
      '<request>Review</request><learned incomplete<notes>Pending</notes>',
    ]) {
      expect(parseAgentXml(`<summary>${body}</summary>`)).toEqual({ valid: false });
    }
  });

  it('preserves legitimate optional and empty fields including a notes-only summary', () => {
    const result = parseAgentXml('<Summary><Request/><Learned> </Learned><Notes>Deployment is pending</Notes></Summary>');
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected notes-only summary');
    expect(result.summary).toEqual({
      request: null, investigated: null, learned: null, completed: null,
      next_steps: null, notes: 'Deployment is pending',
    });
  });

  it('preserves escaped schema names as text, not structural fields', () => {
    const result = parseAgentXml('<summary><learned>Use &lt;completed&gt; with A &amp; B</learned></summary>');
    expect(result.valid && result.summary?.learned).toBe('Use <completed> with A & B');
  });

  it('keeps notes-only responses compatible with surrounding non-schema prose', () => {
    const result = parseAgentXml('Summary follows.\n<summary>Context: <notes>Deployment is pending</notes> End of checkpoint.</summary>\nDone.');
    expect(result.valid && result.summary?.notes).toBe('Deployment is pending');
    expect(result.valid && result.summary?.request).toBeNull();
  });

  it('preserves schema tag examples inside inline and fenced code', () => {
    const learned = 'Literal `<completed>` and `</learned>` examples; incomplete `<learned text` is also code.\n```xml\n<summary><notes>example</summary>\n<learned incomplete\n```\nKeep the actual conclusion.';
    const result = parseAgentXml(`<summary><request>Review parser</request><learned>${learned}</learned></summary>`);
    expect(result.valid && result.summary?.learned).toBe(learned);
  });

  it('preserves schema tag examples inside CDATA and comments without cutting the outer block short', () => {
    const learned = '<![CDATA[<learned>literal </summary> &amp; </notes><learned incomplete]]><!-- </learned> --><code>result</code> A & B';
    const result = parseAgentXml(`<summary><learned>${learned}</learned><notes>Still pending</notes></summary>`);
    expect(result.valid && result.summary?.learned).toBe(learned);
    expect(result.valid && result.summary?.notes).toBe('Still pending');
  });

  it('does not turn a quoted skip sentinel into a skipped summary', () => {
    const result = parseAgentXml('<summary><learned>Emit `<skip_summary reason="noise"/>` for noise.</learned></summary>');
    expect(result.valid && result.summary?.skipped).toBeUndefined();
    expect(result.valid && result.summary?.learned).toContain('skip_summary');
  });

  it('keeps a standalone or fenced skip sentinel compatible', () => {
    for (const raw of ['<skip_summary reason="noise"/>', '```xml\n<Skip_summary reason="noise"/>\n```']) {
      const result = parseAgentXml(raw);
      expect(result.valid && result.summary?.skipped).toBe(true);
      expect(result.valid && result.summary?.skip_reason).toBe('noise');
    }
  });
});
