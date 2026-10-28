import test from 'node:test'
import assert from 'node:assert/strict'
import { BLOG_POSTS } from '../lib/blog/posts.ts'

test('every post (blog and help) has a meta description of at most 160 characters', () => {
  for (const p of BLOG_POSTS) assert.ok(p.description.length <= 160, `${p.slug}: description is ${p.description.length} characters`)
})

test('the rotating-vs-sticky explainer does not promise a rotation timer the product does not have', () => {
  const p = BLOG_POSTS.find((x) => x.slug === 'rotating-vs-sticky-sessions')
  const text = JSON.stringify(p)
  assert.ok(!/set interval you configure|or on a timer/i.test(text))
  assert.match(text, /new connection/)
})
