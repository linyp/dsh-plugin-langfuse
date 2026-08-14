#!/usr/bin/env node
/**
 * Test driver: start a mock Langfuse OTLP collector, boot the fixture Loader
 * composition against it, run one mocked-model turn with a real bash round
 * trip, then persist everything the collector captured to
 * `./otlp-captures.json` for the e2e's inspect step. Erasable-syntax
 * TypeScript only: runs under plain Node type stripping.
 */

import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('langfuse driver requires a config path')

interface Capture {
  path: string
  authorization: string | undefined
  body: unknown
}

const captures: Capture[] = []
const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk as Buffer))
  request.on('end', () => {
    captures.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    })
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('collector has no port')
// The Langfuse-shaped signal path: the fixture config reads this env url.
process.env.LANGFUSE_E2E_URL = `http://127.0.0.1:${address.port}/api/public/otel/v1/traces`

const ctx = await boot('langfuse-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'prove the langfuse trace export' })
} finally {
  await ctx.fiber.dispose()
}
await writeFile('./otlp-captures.json', JSON.stringify(captures))
server.close()
server.closeAllConnections()
