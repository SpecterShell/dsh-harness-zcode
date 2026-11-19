/**
 * End-to-end through the real Agent loop: a selected preset, a scripted model,
 * and a real `Read` invocation whose result reaches the next model request.
 *
 * Only the model is scripted. The session, preset binding, tool registry,
 * executor, filesystem, working directory and the shipped patch rows are the
 * same packages a profile mounts, so a passing run is evidence about the
 * preset, not about a hand-built tool call.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { native } from '../fixtures/native-host.ts'
import { agentApp, answer, callTool } from '../fixtures/agent-app.ts'

const { createUserMessage } = await native('dsh-llm')

await test('a selected ZCode preset runs a real Read through the loop', { timeout: 30_000 }, async t => {
  const app = await agentApp(t, workspace => {
    const target = join(workspace, 'notes.txt')
    // One reply per request: the tool call, the answer after its result, and
    // the memory-extraction reply the context row asks for at turn end.
    return [
      callTool('Read', 'call-read-1', { file_path: target }),
      answer('The notes contain alpha and beta.'),
      answer('Nothing to save.'),
    ]
  })
  const { host, workspace, requests } = app
  const target = join(workspace, 'notes.txt')

  const handle = await host.agents.create({
    sessionId: 'end-to-end-agent',
    agentOptions: { provider: 'fake', model: 'scripted' },
    meta: { cwd: workspace },
  })
  const agent = handle.agent ?? handle
  const session = agent.session

  const selected = await app.presets.select(agent, 'zcode')
  assert.equal(selected, 'zcode', 'the registry reports the selected preset id')
  assert.equal(app.presets.presetForSession(session), 'zcode', 'the session records the selection')

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the notes' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const log = session.log ?? []
  const events = log.map((event: unknown) => (event as { type: string }).type)
  const selection = log.find((event: unknown) => (event as { type: string }).type === 'agent-preset/selected')
  assert.equal(selection?.data?.agentPreset, 'zcode', 'the session log carries the selected preset id')

  const call = log.find((event: unknown) => (event as { type: string }).type === 'tool/call')
  assert.equal(call?.data?.name, 'Read', 'the model invoked Read')
  assert.equal(call?.data?.callId, 'call-read-1')
  assert.equal(JSON.parse(call?.data?.arguments).file_path, target)

  const result = log.find((event: unknown) => (event as { type: string }).type === 'tool/result')
  assert.ok(result, 'the call settled with a result')
  const firstBlock = result?.data?.message?.content?.[0]
  assert.equal(firstBlock?.type, 'text')
  assert.match(firstBlock.text, /1\talpha/u, 'the result carries the real file contents')
  assert.equal(result?.data?.message?.isError ?? false, false)

  // The tool result reached the next model request, not just the log.
  const followUp = requests.at(1)
  const toolTurn = followUp?.messages?.find((message: unknown) => (message as { role?: string }).role === 'tool')
  assert.ok(toolTurn, 'the second request carries the tool result')
  assert.match(JSON.stringify(toolTurn), /alpha/u)

  // The request announced the ZCode tool set, so the preset mask is what the
  // model actually saw.
  assert.deepEqual(
    requests[0]?.tools?.map((tool: unknown) => (tool as { name: string }).name).sort(),
    [
      'Bash',
      'Edit',
      'Read',
      'Write',
      'list_agents',
      'list_subagent_models',
      'send_message',
      'skill',
      'subagent',
      'subagent_fork',
      'wait_agent',
      'workflow',
    ],
  )
  assert.ok(events.includes('assistant/message'), 'the loop produced an assistant message')
  assert.ok(events.includes('turn/end'), 'the turn closed')
})
