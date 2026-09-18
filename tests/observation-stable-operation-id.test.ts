import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildObservationPrompt } from '../src/sdk/prompts.js';

/**
 * T-0077 B：让同一条观测的重投生成**逐字节相同**的提示，并在提示里带上它的
 * 持久身份，好让 credvault 的 forwarder 能证明「字节相同 = 同一条观测」，
 * 从而复用同一把幂等键、不再重复计费。
 *
 * 背景（2026-09-18 实测）：链路抖动造成 502 后，队列层把同一条观测当成全新业务
 * 操作重发，180 秒内 5 次 502 对 5 次重复提交，严格 1:1 —— 每次都真付一次钱。
 */
describe('observation prompt carries a stable operation identity', () => {
  const observation = (over: Partial<Parameters<typeof buildObservationPrompt>[0]> = {}) => ({
    id: 3017,
    tool_name: 'Read',
    tool_input: '{"file_path":"/tmp/a"}',
    tool_output: '{"ok":true}',
    created_at_epoch: 1_758_200_000_000,
    cwd: '/tmp',
    ...over,
  });

  it('embeds the queue row id as a marker the forwarder can find', () => {
    expect(buildObservationPrompt(observation())).toContain('op="[[cm-op:3017]]"');
  });

  it('是逐字节可复现的 —— 这才是整件事成立的前提', () => {
    // 键从请求体指纹算。提示只要有一个字节随时间变（比如用处理时刻当
    // occurred_at），重投就永远拿不回同一把键，上面那个 id 也就白给了。
    expect(buildObservationPrompt(observation())).toBe(buildObservationPrompt(observation()));
  });

  it('不同的行 id 给出不同的标记', () => {
    expect(buildObservationPrompt(observation({ id: 9999 }))).toContain('op="[[cm-op:9999]]"');
  });

  it('没有持久身份时不编造一个', () => {
    // id 为 0 是「这条路径没有行身份」。宁可退回旧行为（forwarder 合成键），
    // 也不能发一个假身份出去 —— 那会让两件不同的事共用一把键、串答案。
    expect(buildObservationPrompt(observation({ id: 0 }))).not.toContain('cm-op');
  });

  it('ClaudeProvider 用行的原始时间戳，不用处理时刻', () => {
    // 钉在源码上：这一条没有可单测的纯函数入口（生成器要整个 SDK 会话），
    // 而它恰恰是「逐字节可复现」的另一半。写死 Date.now() 会让上面那条断言
    // 在真实链路上失效，而单测照样绿 —— 所以这里直接看那一行。
    const source = readFileSync(new URL('../src/services/worker/ClaudeProvider.ts', import.meta.url), 'utf8');
    const call = source.slice(source.indexOf('buildObservationPrompt({'));
    // 去掉注释再查：注释里正当地提到了 Date.now()（说明它为什么被换掉），
    // 裸串匹配会把说明也算成代码。
    const body = call.slice(0, call.indexOf('});'))
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(body).toContain('created_at_epoch: message._originalTimestamp');
    expect(body).toContain('id: message._persistentId');
    expect(body).not.toContain('Date.now()');
  });
});
