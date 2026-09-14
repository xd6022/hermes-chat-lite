/**
 * 真链路用例：拿**真实会话**跑 normalize()，验证工具块的配对 / 参数预览 / 耗时。
 *
 * 为什么必须是 e2e：单测只能喂夹具，而"历史里到底长什么样"是实测出来的
 * （`assistant.tool_calls[].function.arguments` 是 JSON 字符串、结果行 tool 有
 * tool_call_id、时间戳一个 float 一个字符串…）。真数据跑一遍才知道这些假设是否成立。
 *
 * 只读：只 GET 会话与消息，不写任何东西。运行：npm run e2e
 */
import { describe, expect, it } from 'vitest'
import { normalize } from '../src/stores/chat'
import { formatDurationMs } from '../src/lib/format'
import type { HermesMessage } from '../src/api/types'

const BASE = process.env.HERMES_API ?? 'http://hermes:8642'
const KEY = process.env.API_SERVER_KEY ?? ''

async function get(path: string): Promise<any> {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`)
  return r.json()
}

describe('真数据冒烟：真实会话 → normalize 的工具块', () => {
  it('配对率/预览率/耗时率，并打印 UI 会渲染成的样子', async () => {
    const list = await get('/api/sessions?limit=50&offset=0')
    const rows = (list.data as { id: string; message_count?: number }[])
      .slice()
      .sort((a, b) => (b.message_count ?? 0) - (a.message_count ?? 0))
      .slice(0, 5)

    let steps = 0
    let withPreview = 0
    let withMs = 0
    let failed = 0
    let attachedMsgs = 0
    let msgsTotal = 0
    const samples: string[] = []
    const names: Record<string, number> = {}

    for (const s of rows) {
      const d = await get(`/api/sessions/${s.id}/messages?order=latest&limit=300&offset=0`)
      const msgs = normalize(d.data as HermesMessage[])
      msgsTotal += msgs.length
      for (const m of msgs) {
        const t = m.tools ?? []
        if (!t.length) continue
        attachedMsgs++
        for (const step of t) {
          steps++
          if (step.preview) withPreview++
          if (step.ms !== null) withMs++
          if (step.status === 'fail') failed++
          if (step.status === 'run') failed += 0 // run 不该出现在历史里
          names[step.name] = (names[step.name] ?? 0) + 1
          if (samples.length < 8) {
            const mark = step.status === 'ok' ? '✓' : step.status === 'fail' ? '✗' : '●'
            samples.push(
              `${mark} ${step.name}${step.preview ? ` "${step.preview}"` : ''}` +
                `${step.ms !== null ? ` (${formatDurationMs(step.ms)})` : ''}`,
            )
          }
        }
      }
    }

    const pct = (n: number) => `${((n / Math.max(steps, 1)) * 100).toFixed(1)}%`
    console.log(`\n扫了 ${rows.length} 个真实会话 / ${msgsTotal} 条界面消息`)
    console.log(`工具步骤 ${steps} 条，挂在 ${attachedMsgs} 条回复下面`)
    console.log(`  有参数预览: ${withPreview} (${pct(withPreview)})`)
    console.log(`  有耗时    : ${withMs} (${pct(withMs)})`)
    console.log(`  失败(✗)   : ${failed}`)
    console.log(`  工具分布  : ${JSON.stringify(names)}`)
    console.log(`\nUI 会渲染成这样（前 8 行）：`)
    for (const l of samples) console.log('  ' + l)

    expect(steps).toBeGreaterThan(20)
    expect(attachedMsgs).toBeGreaterThan(0)
    // 真实数据上，绝大多数步骤应当能算出耗时（两行 timestamp 都在）
    expect(withMs / Math.max(steps, 1)).toBeGreaterThan(0.5)
    expect(withPreview / Math.max(steps, 1)).toBeGreaterThan(0.5)
  }, 180_000)
})
