/** Explicit opt-in only. This file can NEVER construct a mainnet client. No dotenv loading. */
import { mkdirSync, readFileSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { BybitClient } from './client';
import { BybitExecutor } from './executor';
import { MemoryExecutorStore } from './testing';
import { systemClock } from './types';
import type { Intent, Lease } from './types';

const enabled = process.env.RUN_BYBIT_TESTNET_TESTS === 'true' && process.env.TESTNET_ORDER_TEST_APPROVED === 'true';
function required(key: string): string { const value = process.env[key]; if (!value) throw new Error('Missing testnet variable: ' + key); return value; }

/** A single-process test journal survives a crash between exchange acceptance and local acknowledgment.
 * Production uses Firestore. An exclusive OS file prevents concurrent optional runs against this journal.
 */
class JournalStore extends MemoryExecutorStore {
  private readonly lockFd: number;
  constructor(private readonly path: string) {
    super(); this.lockFd = openSync(path + '.lock', 'wx');
    if (existsSync(path)) {
      const rows = JSON.parse(readFileSync(path, 'utf8')) as Intent[];
      for (const intent of rows) this.intents.set(intent.scope + ':' + intent.scenarioId, intent);
    }
  }
  private persist(): void { writeFileSync(this.path + '.tmp', JSON.stringify([...this.intents.values()], null, 2)); renameSync(this.path + '.tmp', this.path); }
  override async createIntent(lease: Lease, intent: Intent): Promise<boolean> { const created = await super.createIntent(lease, intent); this.persist(); return created; }
  override async saveIntent(lease: Lease, intent: Intent): Promise<void> { await super.saveIntent(lease, intent); this.persist(); }
  dispose(): void { closeSync(this.lockFd); unlinkSync(this.path + '.lock'); }
}

describe.skipIf(!enabled)('Bybit TESTNET opt-in compatibility probe (spends only testnet balance)', () => {
  it('submits initial IOC Full TP/SL, observes native protection, then confirms reduceOnly closure', async () => {
    const uid = required('BYBIT_TESTNET_ACCOUNT_UID');
    const scenarioId = required('BYBIT_TESTNET_PROBE_SCENARIO_ID');
    if (!scenarioId.startsWith('testnet-')) throw new Error('Probe scenario ID must start testnet-');
    const client = new BybitClient({ environment: 'testnet', credentials: { apiKey: required('BYBIT_TESTNET_API_KEY'), apiSecret: required('BYBIT_TESTNET_API_SECRET') } });
    const directory = resolve('.local/bybit-testnet'); mkdirSync(directory, { recursive: true });
    const digest = createHash('sha256').update(uid + ':' + scenarioId).digest('hex');
    const store = new JournalStore(resolve(directory, digest + '.json'));
    const executor = new BybitExecutor(client, store, { tradingMode: 'testnet', environment: 'testnet', expectedAccountId: uid, dedicatedAccountConfirmed: true, allowNewEntries: true });
    let initialProtection = false; let partial = false; let finalStatus = 'NOT_STARTED';
    try {
      await executor.reconcile();
      const book = await client.getBook(); const now = Date.now();
      const result = await executor.execute({
        decision: 'LONG', scenarioId, evaluationId: scenarioId, configHash: 'synthetic-testnet-compatibility-v1',
        validUntilUtc: new Date(now + 60000).toISOString(), expiresAtUtc: new Date(now + 60000).toISOString(),
        isDemo: true, sourcesValidated: false, snapshotSynthetic: true, environment: 'testnet', closeOnScenarioExpiry: true,
        usdPerUsdt: { value: '1', observedAtUtc: new Date(now).toISOString(), verified: true },
        levels: { takeProfitUsd: new Decimal(book.ask).mul('1.1').toFixed(), stopLossUsd: new Decimal(book.ask).mul('0.97').toFixed() },
        costs: { entryFeeBps: '10', exitFeeBps: '10', exitSlippageBps: '10', fundingToTpPerBtcUsdt: '0', fundingToSlPerBtcUsdt: '0', description: 'Explicit synthetic testnet assumptions, close immediately after compatibility observation' },
        minRewardRisk: '1.5',
      });
      const intent = [...store.intents.values()].find(i => i.scenarioId === scenarioId);
      initialProtection = intent?.initialProtectionConfirmed === true;
      partial = Boolean(intent && new Decimal(intent.qtyFilled).gt(0) && new Decimal(intent.qtyFilled).lt(intent.plan.qty));
      expect(result.status, result.reasonCodes.join(',')).toBe('PROTECTED');
      expect(initialProtection, 'Protection repaired later does not prove initial IOC TP/SL compatibility').toBe(true);
    } finally {
      // Persist expiry before closing, so the same journal can reconcile after interruption.
      const lease = await store.acquire(executor.scope, 'testnet-probe-cleanup', Date.now(), 240000);
      if (lease) {
        for (const intent of await store.readIntents(lease)) {
          if (!['CLOSED', 'REJECTED', 'CANCELLED'].includes(intent.state)) {
            intent.expiresAtUtc = new Date(Date.now() - 1).toISOString(); intent.closeOnScenarioExpiry = true;
            await store.saveIntent(lease, intent);
          }
        }
        await store.release(lease);
      }
      for (let i = 0; i < 15; i++) {
        finalStatus = (await executor.reconcile()).status;
        const active = [...store.intents.values()].some(intent => !['CLOSED', 'REJECTED', 'CANCELLED'].includes(intent.state));
        if (!active) break;
        await systemClock.sleep(2000);
      }
      // Evidence deliberately cannot claim partial-fill compatibility after observing only a full fill.
      writeFileSync(resolve(directory, digest + '.evidence.json'), JSON.stringify({ environment: 'testnet', executorVersion: '1.0.0',
        combination: 'BTCUSDT:Limit:IOC:Full:Market:LastPrice', evidenceId: digest, verifiedAtUtc: new Date().toISOString(),
        initialProtectionConfirmed: initialProtection, partialFillProtectionConfirmed: partial && initialProtection, finalStatus,
      }, null, 2));
      store.dispose();
      expect([...store.intents.values()].every(intent => ['CLOSED', 'REJECTED', 'CANCELLED'].includes(intent.state)), 'Testnet exposure unresolved: resume the same journal; never assume flat after a timeout').toBe(true);
    }
  }, 180000);
});
