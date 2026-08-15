#!/usr/bin/env node
/**
 * Cloud test driver: boot the cloud fixture composition against the real
 * Langfuse OTLP endpoint, run one mocked-model turn with a real bash round
 * trip, fork a child session, and persist their ids to
 * `./cloud-session.json` so the e2e can find the exported traces through
 * Langfuse's public API. Disposal drains the exporter before exit.
 * Erasable-syntax TypeScript only.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('langfuse cloud driver requires a config path')

const ctx = await boot('langfuse-cloud-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'prove the langfuse cloud export' })
  const sessions = ctx.get('sessions')?.list() ?? []
  const sessionIds = sessions.map((session: { id: string }) => session.id)
  if (sessionIds.length === 0) throw new Error('langfuse cloud driver saw no session after the fixture turn')
  const feedbackText = `dsh-plugin-langfuse cloud e2e ${Date.now()}`
  recordFeedback(sessions[0]!, feedbackText)
  const parent = sessions[0]!
  const child = ctx.sessions.fork(parent)
  child.append('turn/start', { turn: 2 })
  child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  sessionIds.push(child.id)
  await writeFile('./cloud-session.json', JSON.stringify({
    sessionIds,
    parentSessionId: parent.id,
    childSessionId: child.id,
    feedbackText,
  }))
} finally {
  await ctx.fiber.dispose()
}
