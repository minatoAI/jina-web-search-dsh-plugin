/**
 * Contract tests for the model-facing web search tool (TDD: written first, RED).
 *
 * Contract under test (tool-contracts.js — pure data, zero deps):
 *   WEB_SEARCH_TOOL = { name, description, parameters }
 * index.js registers the tool by spreading this constant, so it IS the exact
 * selection signal the model sees via the native `tools` request field:
 * `{ name, description, parameters }`. These tests pin that signal so
 * the naming and description improvements cannot silently regress.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WEB_SEARCH_TOOL } from '../tool-contracts.js'

test('web search tool: renamed to jina_web_search (no bare jina_search)', () => {
  assert.equal(WEB_SEARCH_TOOL.name, 'jina_web_search')
})

test('web search tool: description opens task-first with the action', () => {
  assert.match(WEB_SEARCH_TOOL.description, /^Search the web/i)
})

test('web search tool: description carries a when-to-use trigger', () => {
  assert.match(WEB_SEARCH_TOOL.description, /Use this (tool|whenever|when)/i)
})

test('web search tool: description spells out the division of labor with the built-in web_search', () => {
  assert.match(WEB_SEARCH_TOOL.description, /web_search/)
  assert.match(WEB_SEARCH_TOOL.description, /built-in/)
})

test('web search tool: description keeps the academic-tools pointer', () => {
  assert.match(WEB_SEARCH_TOOL.description, /jina_search_arxiv/)
  assert.match(WEB_SEARCH_TOOL.description, /jina_search_ssrn/)
})

test('web search tool: description states the jina differentiators (official sources first, time filters)', () => {
  assert.match(WEB_SEARCH_TOOL.description, /official/i)
  assert.match(WEB_SEARCH_TOOL.description, /time filter/i)
})

test('web search tool: parameters remain a full JSON Schema object', () => {
  assert.equal(WEB_SEARCH_TOOL.parameters.type, 'object')
  assert.equal(WEB_SEARCH_TOOL.parameters.additionalProperties, false)
  assert.deepEqual(WEB_SEARCH_TOOL.parameters.required, ['query'])
})

test('web search tool: query parameter gives real guidance mentioning the time filter', () => {
  const q = WEB_SEARCH_TOOL.parameters.properties.query
  assert.equal(q.type, 'string')
  assert.match(q.description, /time/i)
  assert.ok(q.description.length >= 60, 'query description should be real guidance, not a bare label')
})

test('web search tool: query parameter warns off the built-in web_search `queries` key', () => {
  // A live session sent `{queries: [...]}` and the plugin searched for the
  // literal string "undefined" (see test/tool-args.test.js). The parameter
  // description is the cheapest place to stop that at the source.
  const q = WEB_SEARCH_TOOL.parameters.properties.query
  assert.match(q.description, /queries/)
  assert.match(q.description, /web_search/)
})

test('web search tool: model-facing description stays within the context-budget budget', () => {
  assert.ok(WEB_SEARCH_TOOL.description.length <= 600,
    'a bloated description is permanent per-request prefix token cost; keep it lean')
})
