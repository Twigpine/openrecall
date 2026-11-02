import { describe, expect, test } from 'bun:test'
import { activeLockCount, withLock } from '../src/lock.ts'

describe('withLock', () => {
  test('serializes critical sections for the same key', async () => {
    const order: number[] = []
    let running = 0
    let overlap = false
    const task = (n: number) =>
      withLock('k', async () => {
        running++
        if (running > 1) overlap = true
        await Promise.resolve()
        order.push(n)
        running--
      })
    await Promise.all([task(1), task(2), task(3)])
    expect(overlap).toBe(false)
    expect(order).toEqual([1, 2, 3])
  })

  test('does not leak lock-table entries once sections complete', async () => {
    // Distinct keys, each fully awaited: the table must return to empty.
    for (let i = 0; i < 100; i++) {
      await withLock(`ns:${i}`, async () => i)
    }
    // Concurrent contention on one key must also drain.
    await Promise.all(Array.from({ length: 20 }, () => withLock('hot', async () => 1)))
    expect(activeLockCount()).toBe(0)
  })

  test('cleans up even when the critical section throws', async () => {
    await expect(
      withLock('boom', async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')
    expect(activeLockCount()).toBe(0)
  })
})
