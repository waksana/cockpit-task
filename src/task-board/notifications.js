import { taskReference } from './reference.js';

const detail = (error, code) => ({
  code,
  message: String(error?.message ?? error ?? 'Host did not confirm notification acceptance').slice(0, 2000),
});

export async function deliverNotification({ store, host, id, stopped }) {
  let subscription = store.getSubscription(id);
  if (subscription.notification.status !== 'pending' || stopped()) return subscription;
  try {
    if (!await host.ownerExists(subscription.owner)) {
      return store.finishNotification(id, 'pending', 'not_sent', {
        code: 'OWNER_NOT_FOUND', message: 'Task Owner session does not exist; no replacement session was created and nothing was sent',
      });
    }
  } catch (error) {
    // This read cannot send. Retain explicit known-unsent evidence rather than retrying the host.
    return store.finishNotification(id, 'pending', 'not_sent', detail(error, 'OWNER_UNAVAILABLE'));
  }
  if (stopped()) return store.getSubscription(id);
  subscription = store.claimNotification(id);
  if (!subscription) return store.getSubscription(id);
  let receipt;
  try {
    receipt = await host.send(subscription.owner, taskReference(subscription.task_id, 'status_changed'));
  } catch (error) {
    return store.finishNotification(id, 'unknown', 'unknown', detail(error, 'NOTIFICATION_UNCONFIRMED'));
  }
  if (receipt?.ok !== true) {
    return store.finishNotification(id, 'unknown', 'unknown', detail(receipt?.error, 'NOTIFICATION_UNCONFIRMED'));
  }
  return store.finishNotification(id, 'unknown', receipt.queued === true ? 'queued' : 'accepted');
}
