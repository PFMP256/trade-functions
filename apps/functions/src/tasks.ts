import { CloudTasksClient } from '@google-cloud/tasks';
import { hash } from './audit-store';

export interface ReconcileQueueConfig { project: string; region: string; queue: string; url: string; serviceAccountEmail: string; }
export class ReconcileQueue {
  private readonly dispatched = new Set<string>();
  constructor(private readonly config: ReconcileQueueConfig, private readonly client = new CloudTasksClient()) {}
  async check(): Promise<void> { await this.client.getQueue({ name: this.parent() },{timeout:2000,retry:null}); }
  private parent(): string { return this.client.queuePath(this.config.project, this.config.region, this.config.queue); }
  async enqueue(scope: string, dueUtc: string): Promise<void> {
    // At most one task per scope/time bucket. A permanent minute-level recovery job
    // also reconciles every durable intent, including a crash before task creation.
    const seconds = Math.max(Math.ceil(Date.now()/1000) + 20, Math.ceil(Date.parse(dueUtc)/1000));
    const slot = Math.ceil(seconds/20)*20;
    const taskId = hash({scope, slot});
    if (this.dispatched.has(taskId)) return;
    try {
      await this.client.createTask({ parent: this.parent(), task: {
        name: this.client.taskPath(this.config.project, this.config.region, this.config.queue, taskId),
        scheduleTime: {seconds: slot}, dispatchDeadline: {seconds: 180},
        httpRequest: { httpMethod:'POST', url:this.config.url,
          headers: {'Content-Type':'application/json'}, body:Buffer.from(JSON.stringify({kind:'reconcile'})).toString('base64'),
          oidcToken:{serviceAccountEmail:this.config.serviceAccountEmail,audience:this.config.url},
        },
      }},{timeout:2000,retry:null});
      this.dispatched.add(taskId);
    } catch (error) {
      if ((error as {code?:number}).code !== 6) throw new Error('RECONCILIATION_QUEUE_UNAVAILABLE');
      this.dispatched.add(taskId);
    }
  }
}
