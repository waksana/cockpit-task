import { taskReference } from './reference.js';

const detail = (error, code) => ({
  code,
  message: String(error?.message ?? error ?? 'Host did not confirm notification acceptance').slice(0, 2000),
});

export async function deliverNotification({ store, host, id, stopped }) {
  const channel = store.notificationChannel(id);
  const recipient = channel.recipient ?? 'orchestrator';
  const label = recipient.toUpperCase();
  let subscription = channel.read();
  if (subscription.notification.status !== 'pending' || stopped()) return subscription;
  try {
    if (!await host.sessionExists(subscription[recipient])) {
      return store.finishNotification(id, 'pending', 'not_sent', {
        code: `${label}_NOT_FOUND`, message: `Task ${recipient} session does not exist; no replacement session was created and nothing was sent`,
      });
    }
  } catch (error) {
    // This read cannot send. Retain explicit known-unsent evidence rather than retrying the host.
    return store.finishNotification(id, 'pending', 'not_sent', detail(error, `${label}_UNAVAILABLE`));
  }
  if (stopped()) return channel.read();
  subscription = store.claimNotification(id);
  if (!subscription) return channel.read();
  let receipt;
  try {
    receipt = channel.mode === 'immediate'
      ? await host.send(subscription[recipient], taskReference(subscription.task_id, channel.event), { mode: 'immediate' })
      : await host.send(subscription[recipient], taskReference(subscription.task_id, channel.event));
  } catch (error) {
    return store.finishNotification(id, 'unknown', 'unknown', detail(error, 'NOTIFICATION_UNCONFIRMED'));
  }
  if (receipt?.ok !== true) {
    return store.finishNotification(id, 'unknown', 'unknown', detail(receipt?.error, 'NOTIFICATION_UNCONFIRMED'));
  }
  return store.finishNotification(id, 'unknown', receipt.queued === true ? 'queued' : 'accepted');
}
